import {
  withSerializedDatabaseOperation,
  type DatabaseConnection,
} from "../../database";
import type { MarketInfo, Order, OrderBook, Position } from "../exchange.types";
import { LighterAdapter } from "./lighter.adapter";
import {
  assertLighterExecutionAllowed,
  loadLighterConfig,
  type LighterConfig,
} from "./lighter.config";
import {
  floorToAmountStep,
  toLighterPerpetualSymbol,
} from "./lighter.market-mapper";

/**
 * Mirrors the paper-trading engine onto a real (testnet) Lighter account.
 *
 * The paper engine stays authoritative: it decides direction, size, stops and
 * exits. This bridge only replays the resulting open/close events as futures
 * orders with the configured leverage. It never invents a trade, and it never
 * touches the paper database state, so a venue outage cannot corrupt the
 * simulation.
 */

export interface PaperExecutionPosition {
  id: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  notional: number;
}

export type ExecutionAction = "OPEN" | "CLOSE" | "RECONCILE_CLOSE";

export interface LighterExecutionBridgeOptions {
  connection: DatabaseConnection;
  config?: LighterConfig;
  adapter?: LighterAdapter;
  log?: (message: string) => void;
  /** Injectable clock and sleep keep the unit tests deterministic. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP_MS = 2_000;

/**
 * Lighter signs the price into every order, including market orders, so the
 * bridge needs a worst acceptable price. The best quote on the relevant side
 * is used when present; an empty testnet book falls back to the other side and
 * then to the last trade rather than producing a NaN order.
 */
export function worstAcceptablePrice(
  side: "buy" | "sell",
  book: OrderBook,
  last: number | null,
  slippagePct: number,
): number | null {
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;

  const reference =
    side === "buy"
      ? (bestAsk ?? bestBid ?? last)
      : (bestBid ?? bestAsk ?? last);

  if (
    reference === null ||
    !Number.isFinite(reference) ||
    reference <= 0
  ) {
    return null;
  }

  const factor =
    side === "buy" ? 1 + slippagePct / 100 : 1 - slippagePct / 100;

  return reference * factor;
}

/** True when a venue position belongs to the symbols this bridge manages. */
export function isManagedVenueSymbol(
  symbol: string,
  supportedBases: readonly string[],
): boolean {
  return toLighterPerpetualSymbol(symbol, supportedBases) !== null;
}

/**
 * Lighter acknowledges an IOC market order with a transaction hash rather than
 * an order id, because the order may already be gone. The audit trail keeps
 * whichever identifier the venue returned.
 */
export function orderReference(order: Order): string | null {
  if (order.id) return order.id;

  const raw = order.raw as Record<string, unknown> | null;
  const info = raw?.info as Record<string, unknown> | undefined;
  const hash = raw?.tx_hash ?? info?.tx_hash;

  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/** "unknown" is CCXT's status for a bare transaction acknowledgement. */
export function orderAuditStatus(order: Order): string {
  return order.status === "unknown" ? "submitted" : order.status;
}

export class LighterExecutionBridge {
  private readonly config: LighterConfig;
  private readonly adapter: LighterAdapter;
  private readonly connection: DatabaseConnection;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private queue: Promise<void> = Promise.resolve();
  private leverageApplied = new Set<string>();
  private markets: MarketInfo[] | null = null;
  private lastReconcile = 0;
  private missingLogged = new Set<string>();

  constructor(options: LighterExecutionBridgeOptions) {
    const baseConfig = options.config ?? loadLighterConfig();

    // Orders and the book they are priced from must come from the same
    // deployment, even when the bot's research data uses another environment.
    this.config = {
      ...baseConfig,
      marketDataEnvironment: baseConfig.privateApiEnvironment,
    };
    this.adapter = options.adapter ?? new LighterAdapter({ config: this.config });
    this.connection = options.connection;
    this.log = options.log ?? ((message) => console.log(message));
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Opens the signing client, applies leverage and prepares the audit table. */
  async connect(): Promise<void> {
    assertLighterExecutionAllowed(this.config);
    await this.ensureAuditTable();
    await this.adapter.connect();

    const auth = this.adapter.getAuthInfo();
    const balances = await this.adapter.getBalance();
    const usdc = balances.find((entry) => entry.currency.toUpperCase() === "USDC");

    this.log(
      `[EXEC] Lighter ${this.config.privateApiEnvironment} | account ${auth.accountIndex} | ` +
        `api key ${auth.apiKeyIndex} | ${auth.baseUrl}`,
    );
    this.log(
      `[EXEC] USDC balance ${usdc ? usdc.total.toFixed(2) : "unavailable"} | ` +
        `leverage ${this.config.execution.leverage}x ${this.config.execution.marginMode}`,
    );

    for (const base of this.config.execution.symbols) {
      const symbol = this.toVenueSymbol(base);
      if (!symbol) continue;

      try {
        await this.ensureLeverage(symbol);
      } catch (error) {
        // Trading can still continue at the account's existing leverage; the
        // failure is loud in the log instead of aborting the whole bot.
        this.log(
          `[EXEC] Could not set ${this.config.execution.leverage}x on ${symbol}: ` +
            this.adapter.redact(error),
        );
      }
    }
  }

  /** Queues an open. Execution is asynchronous and never blocks the paper loop. */
  onOpen(position: PaperExecutionPosition): void {
    this.enqueue(() => this.mirrorOpen(position), `open ${position.symbol}`);
  }

  /** Queues a reduce-only close of the matching venue position. */
  onClose(position: PaperExecutionPosition, exitReason: string): void {
    this.enqueue(
      () => this.mirrorClose(position, exitReason),
      `close ${position.symbol}`,
    );
  }

  /**
   * Closes venue positions that no longer exist in the paper book. This is the
   * safety net for a crash between the paper commit and the venue order.
   */
  reconcile(openPositions: PaperExecutionPosition[]): void {
    if (this.now() - this.lastReconcile < this.config.execution.reconcileIntervalMs) {
      return;
    }
    this.lastReconcile = this.now();
    this.enqueue(
      () => this.mirrorReconcile(openPositions),
      "reconcile",
    );
  }

  /** Waits for every queued venue operation to finish. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.adapter.close();
  }

  // -------------------------------------------------------------------------
  // Order mirroring
  // -------------------------------------------------------------------------

  private async mirrorOpen(position: PaperExecutionPosition): Promise<void> {
    const symbol = this.toVenueSymbol(position.symbol);
    if (!symbol) {
      this.log(
        `[EXEC] ${position.symbol} is not executable on Lighter ` +
          `(${this.config.execution.symbols.join(", ")}); paper only`,
      );
      return;
    }

    const market = await this.market(symbol);

    try {
      await this.ensureLeverage(symbol);
    } catch (error) {
      // An existing leverage setting is still usable; refusing to trade would
      // be worse than trading at the account's current margin.
      this.log(
        `[EXEC] WARN could not set ${this.config.execution.leverage}x on ${symbol}: ` +
          this.adapter.redact(error),
      );
    }

    const amount = floorToAmountStep(position.quantity, market.amountStep);
    if (!(amount > 0)) {
      this.log(`[EXEC] OPEN ${symbol} skipped: quantity ${position.quantity} rounds to zero`);
      return;
    }
    if (market.minAmount !== null && amount < market.minAmount) {
      this.log(
        `[EXEC] OPEN ${symbol} skipped: ${amount} is below min amount ${market.minAmount}`,
      );
      return;
    }

    const side = position.direction === "long" ? "buy" : "sell";
    const price = await this.worstPrice(symbol, side);
    if (price === null) {
      throw new Error(`no usable ${side} price for ${symbol}`);
    }

    if (market.minCost !== null && amount * price < market.minCost) {
      this.log(
        `[EXEC] OPEN ${symbol} skipped: notional ${(amount * price).toFixed(2)} ` +
          `is below min ${market.minCost}`,
      );
      return;
    }

    try {
      const order = await this.adapter.createOrder({
        symbol,
        type: "market",
        side,
        amount,
        price,
      });

      await this.record({
        paperPositionId: position.id,
        action: "OPEN",
        symbol,
        side,
        amount,
        price,
        orderId: orderReference(order),
        status: orderAuditStatus(order),
      });

      this.log(
        `[EXEC] OPEN ${symbol} ${side.toUpperCase()} ${amount} @ worst ${price.toFixed(4)} ` +
          `| ${this.config.execution.leverage}x ${this.config.execution.marginMode} ` +
          `| order ${orderReference(order) ?? "?"} ${orderAuditStatus(order)}`,
      );

      await this.verifyOpen(symbol, position.direction, amount);
    } catch (error) {
      await this.recordFailure(position.id, "OPEN", symbol, side, amount, price, error);
      throw error;
    }
  }

  private async mirrorClose(
    position: PaperExecutionPosition,
    exitReason: string,
  ): Promise<void> {
    const symbol = this.toVenueSymbol(position.symbol);
    if (!symbol) return;

    const venue = await this.positionsFor(symbol);
    const held = venue.find((item) => Math.abs(item.contracts) > 0);
    const market = await this.market(symbol);

    const amount = held
      ? Math.abs(held.contracts)
      : floorToAmountStep(position.quantity, market.amountStep);

    if (!(amount > 0)) {
      this.log(`[EXEC] CLOSE ${symbol} skipped: nothing to close`);
      return;
    }

    const side = held
      ? held.side === "long"
        ? "sell"
        : "buy"
      : position.direction === "long"
        ? "sell"
        : "buy";

    const price = await this.worstPrice(symbol, side);
    if (price === null) {
      throw new Error(`no usable ${side} price for ${symbol}`);
    }

    try {
      const order = await this.adapter.createOrder({
        symbol,
        type: "market",
        side,
        amount,
        price,
        reduceOnly: true,
      });

      await this.record({
        paperPositionId: position.id,
        action: "CLOSE",
        symbol,
        side,
        amount,
        price,
        orderId: orderReference(order),
        status: orderAuditStatus(order),
      });

      this.log(
        `[EXEC] CLOSE ${symbol} ${side.toUpperCase()} ${amount} (reduce only) ` +
          `@ worst ${price.toFixed(4)} | ${exitReason} | order ${order.id ?? "?"} ${order.status}`,
      );

      await this.verifyClosed(symbol);
    } catch (error) {
      await this.recordFailure(position.id, "CLOSE", symbol, side, amount, price, error);
      throw error;
    }
  }

  private async mirrorReconcile(
    openPositions: PaperExecutionPosition[],
  ): Promise<void> {
    const managed = openPositions
      .map((position) => this.toVenueSymbol(position.symbol))
      .filter((symbol): symbol is string => symbol !== null);

    for (const base of this.config.execution.symbols) {
      const symbol = this.toVenueSymbol(base);
      if (!symbol) continue;

      const venue = await this.positionsFor(symbol);

      if (managed.includes(symbol) && venue.length === 0) {
        if (!this.missingLogged.has(symbol)) {
          this.missingLogged.add(symbol);
          this.log(
            `[EXEC] WARN ${symbol} has an open paper position but no venue position; ` +
              `the entry may not have filled on a thin book`,
          );
        }
      } else if (venue.length > 0) {
        this.missingLogged.delete(symbol);
      }

      for (const held of venue) {
        if (Math.abs(held.contracts) <= 0) continue;
        if (managed.includes(symbol)) continue;

        const side = held.side === "long" ? "sell" : "buy";
        const amount = Math.abs(held.contracts);
        const price = await this.worstPrice(symbol, side);
        if (price === null) continue;

        const order = await this.adapter.createOrder({
          symbol,
          type: "market",
          side,
          amount,
          price,
          reduceOnly: true,
        });

        await this.record({
          paperPositionId: "reconcile",
          action: "RECONCILE_CLOSE",
          symbol,
          side,
          amount,
          price,
          orderId: orderReference(order),
          status: orderAuditStatus(order),
        });

        this.log(
          `[EXEC] RECONCILE closed orphan ${symbol} ${side.toUpperCase()} ${amount} ` +
            `| order ${orderReference(order) ?? "?"} ${orderAuditStatus(order)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toVenueSymbol(symbol: string): string | null {
    return toLighterPerpetualSymbol(symbol, this.config.execution.symbols);
  }

  private async ensureLeverage(symbol: string): Promise<void> {
    if (this.leverageApplied.has(symbol)) return;

    await this.adapter.setLeverage(
      symbol,
      this.config.execution.leverage,
      this.config.execution.marginMode,
    );
    this.leverageApplied.add(symbol);
    this.log(
      `[EXEC] ${symbol} leverage set to ${this.config.execution.leverage}x ` +
        `${this.config.execution.marginMode}`,
    );
  }

  private async market(symbol: string): Promise<MarketInfo> {
    if (!this.markets) {
      this.markets = await this.adapter.getMarkets();
    }

    const market = this.markets.find((candidate) => candidate.symbol === symbol);
    if (!market) {
      throw new Error(`Lighter market ${symbol} is not available on this deployment`);
    }

    return market;
  }

  private async worstPrice(
    symbol: string,
    side: "buy" | "sell",
  ): Promise<number | null> {
    const book = await this.adapter.getOrderBook(symbol, 5);
    const ticker = await this.adapter.getTicker(symbol);

    return worstAcceptablePrice(
      side,
      book,
      ticker.last,
      this.config.execution.worstPriceSlippagePct,
    );
  }

  private async positionsFor(symbol: string): Promise<Position[]> {
    const positions = await this.adapter.getPositions();
    return positions.filter(
      (position) => position.symbol === symbol && Math.abs(position.contracts) > 0,
    );
  }

  private async verifyOpen(
    symbol: string,
    direction: "long" | "short",
    expected: number,
  ): Promise<void> {
    await this.sleep(DEFAULT_SLEEP_MS);
    const held = (await this.positionsFor(symbol)).find(
      (position) => position.side === direction,
    );

    if (!held) {
      this.log(
        `[EXEC] WARN ${symbol} ${direction} did not appear on the venue after ` +
          `${DEFAULT_SLEEP_MS}ms; the testnet book may be too thin to fill`,
      );
      return;
    }

    if (Math.abs(held.contracts) + Number.EPSILON < expected) {
      this.log(
        `[EXEC] WARN ${symbol} partial fill: ${Math.abs(held.contracts)} of ${expected}`,
      );
    }
  }

  private async verifyClosed(symbol: string): Promise<void> {
    await this.sleep(DEFAULT_SLEEP_MS);
    const held = await this.positionsFor(symbol);

    if (held.length > 0) {
      this.log(
        `[EXEC] WARN ${symbol} still shows ${held[0]!.contracts} after the close order`,
      );
    }
  }

  private enqueue(task: () => Promise<void>, label: string): void {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => {
        this.log(`[EXEC] ${label} failed: ${this.adapter.redact(error)}`);
      });
  }

  private async ensureAuditTable(): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(`
        CREATE TABLE IF NOT EXISTS lighter_executions (
          id VARCHAR PRIMARY KEY,
          paper_position_id VARCHAR NOT NULL,
          action VARCHAR NOT NULL,
          symbol VARCHAR NOT NULL,
          side VARCHAR NOT NULL,
          amount DOUBLE NOT NULL,
          price DOUBLE NOT NULL,
          order_id VARCHAR,
          status VARCHAR NOT NULL,
          error VARCHAR,
          created_at BIGINT NOT NULL
        )
      `),
    );
  }

  private async record(entry: {
    paperPositionId: string;
    action: ExecutionAction;
    symbol: string;
    side: string;
    amount: number;
    price: number | null;
    orderId: string | null;
    status: string;
    error?: string | null;
  }): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `INSERT INTO lighter_executions
         (id, paper_position_id, action, symbol, side, amount, price, order_id,
          status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          entry.paperPositionId,
          entry.action,
          entry.symbol,
          entry.side,
          entry.amount,
          entry.price ?? 0,
          entry.orderId,
          entry.status,
          entry.error ?? null,
          this.now(),
        ],
      ),
    );
  }

  private async recordFailure(
    paperPositionId: string,
    action: ExecutionAction,
    symbol: string,
    side: string,
    amount: number,
    price: number | null,
    error: unknown,
  ): Promise<void> {
    await this.record({
      paperPositionId,
      action,
      symbol,
      side,
      amount,
      price,
      orderId: null,
      status: "ERROR",
      error: this.adapter.redact(error).slice(0, 1_000),
    }).catch(() => undefined);
  }
}

export function createLighterExecutionBridge(
  options: LighterExecutionBridgeOptions,
): LighterExecutionBridge {
  return new LighterExecutionBridge(options);
}
