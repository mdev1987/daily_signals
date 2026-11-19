import {
  withSerializedDatabaseOperation,
  type DatabaseConnection,
} from "../../database";
import type { MarketInfo, Order, OrderBook, Position } from "../exchange.types";
import { ExchangeConfigurationError } from "../exchange.errors";
import { LighterAdapter } from "./lighter.adapter";
import { PAPER_STOP_LOSS_PCT } from "../../config";
import {
  assertLighterExecutionAllowed,
  assertStopBeforeLiquidation,
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

export type ExecutionAction =
  | "OPEN"
  | "CLOSE"
  | "RECONCILE_CLOSE"
  | "SHUTDOWN_CLOSE"
  | "SKIPPED";

/**
 * What the bot believes it owns on the venue, keyed by the paper position that
 * caused it. A venue position is never closed unless a matching `OPEN` row
 * exists here with a positive remaining size.
 */
export interface OwnedVenuePosition {
  paperPositionId: string;
  symbol: string;
  side: "long" | "short";
  requestedAmount: number;
  filledAmount: number;
  closedAmount: number;
  averagePrice: number | null;
  orderId: string | null;
  /** OPEN = verified and manageable. UNVERIFIED = never claim it. */
  status: "OPEN" | "CLOSED" | "UNVERIFIED";
}

/** Amounts below this are treated as fully closed (venue size steps). */
const OWNERSHIP_EPSILON = 1e-9;

export interface LighterExecutionBridgeOptions {
  connection: DatabaseConnection;
  config?: LighterConfig;
  adapter?: LighterAdapter;
  /** Paper stop loss, used to reject leverage that liquidates before it. */
  stopLossPct?: number;
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
  private readonly stopLossPct: number;
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
    this.stopLossPct = options.stopLossPct ?? PAPER_STOP_LOSS_PCT;
    this.log = options.log ?? ((message) => console.log(message));
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Opens the signing client, applies leverage and prepares the audit table. */
  async connect(): Promise<void> {
    assertLighterExecutionAllowed(this.config);
    assertStopBeforeLiquidation(this.config, this.stopLossPct);
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

      // Fail closed: `assertStopBeforeLiquidation()` and the margin check both
      // assume the requested leverage is actually applied. Refusing to start is
      // safer than trading at an unknown account leverage.
      try {
        await this.ensureLeverage(symbol);
      } catch (error) {
        throw new ExchangeConfigurationError(
          `Could not set ${this.config.execution.leverage}x on ${symbol}: ` +
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

    if (this.config.execution.flattenOnShutdown) {
      try {
        await this.flattenOwned("SHUTDOWN_CLOSE");
      } catch (error) {
        this.log(
          `[EXEC] shutdown flatten failed: ${this.adapter.redact(error)}; ` +
            `check the venue for open positions`,
        );
      }
    }

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

    const side = position.direction === "long" ? "buy" : "sell";
    let amount = 0;
    let price: number | null = null;

    try {
      const market = await this.market(symbol);

      // A duplicate open event must never add to an already-owned position.
      const alreadyOwned = await this.loadOwnership(position.id);
      if (alreadyOwned && alreadyOwned.status !== "CLOSED") {
        await this.skip(
          position,
          symbol,
          side,
          `paper position ${position.id} is already owned by this bot ` +
            `(${alreadyOwned.status}, ${alreadyOwned.filledAmount - alreadyOwned.closedAmount} open)`,
        );
        return;
      }

      // Fail closed: an unknown account leverage invalidates both the
      // liquidation guard and the margin estimate.
      try {
        await this.ensureLeverage(symbol);
      } catch (error) {
        await this.skip(
          position,
          symbol,
          side,
          `leverage ${this.config.execution.leverage}x was not applied: ` +
            this.adapter.redact(error),
        );
        return;
      }

      // A venue position the bot did not open (a manual trade or another
      // process) must not be stacked onto, and a resting order on the same
      // market could fill into one.
      const existing = await this.positionsFor(symbol);
      if (existing.length > 0) {
        await this.skip(
          position,
          symbol,
          side,
          `venue already holds ${existing[0]!.side} ${Math.abs(existing[0]!.contracts)}`,
        );
        return;
      }

      const openOrders = await this.adapter.getOpenOrders(symbol);
      if (openOrders.length > 0) {
        await this.skip(
          position,
          symbol,
          side,
          `venue has ${openOrders.length} open order(s) on the market`,
        );
        return;
      }

      amount = floorToAmountStep(
        position.quantity * this.config.execution.sizeMultiplier,
        market.amountStep,
      );
      if (!(amount > 0)) {
        await this.skip(position, symbol, side, `quantity ${position.quantity} rounds to zero`);
        return;
      }
      if (market.minAmount !== null && amount < market.minAmount) {
        await this.skip(
          position,
          symbol,
          side,
          `${amount} is below min amount ${market.minAmount} ` +
            `(raise LIGHTER_SIZE_MULTIPLIER)`,
        );
        return;
      }

      price = await this.worstPrice(symbol, side);
      if (price === null) {
        throw new Error(`no usable ${side} price for ${symbol}`);
      }

      if (market.minCost !== null && amount * price < market.minCost) {
        await this.skip(
          position,
          symbol,
          side,
          `notional ${(amount * price).toFixed(2)} is below min ${market.minCost} ` +
            `(raise LIGHTER_SIZE_MULTIPLIER)`,
        );
        return;
      }

      // The size multiplier can inflate a small paper trade; cap the resulting
      // exposure independently of the multiplier.
      const notional = amount * price;
      const cap = this.config.execution.maxNotionalUsd;
      if (cap > 0 && notional > cap) {
        await this.skip(
          position,
          symbol,
          side,
          `notional ${notional.toFixed(2)} exceeds LIGHTER_MAX_NOTIONAL_USD ${cap}`,
        );
        return;
      }

      // Fail closed: without a readable free balance the margin check cannot
      // run, so no entry is allowed.
      const requiredMargin = notional / this.config.execution.leverage;
      const free = await this.freeUsdc();
      if (free === null) {
        await this.skip(
          position,
          symbol,
          side,
          `free USDC collateral is unavailable; refusing to open`,
        );
        return;
      }
      if (requiredMargin > free) {
        await this.skip(
          position,
          symbol,
          side,
          `needs ${requiredMargin.toFixed(2)} USDC margin but only ${free.toFixed(2)} is free`,
        );
        return;
      }

      const order = await this.adapter.createOrder({
        symbol,
        type: "market",
        side,
        amount,
        price,
      });

      const reference = orderReference(order);
      const confirmation = await this.verifyOpen(
        symbol,
        position.direction,
        amount,
      );
      const reportedFill =
        order.filled !== null && Number.isFinite(order.filled) && order.filled > 0
          ? order.filled
          : 0;
      const filled = Math.min(
        amount,
        Math.max(reportedFill, confirmation.filled),
      );
      const averagePrice = confirmation.entryPrice ?? order.price ?? price;

      // The venue's reported leverage is derived from the position's initial
      // margin fraction. If it exceeds the configured value the liquidation
      // guard no longer holds, so unwind immediately instead of leaving a
      // position whose risk the bot cannot model.
      const actualLeverage = confirmation.leverage;
      if (
        actualLeverage !== null &&
        actualLeverage > this.config.execution.leverage * 1.01
      ) {
        await this.recordFailure(
          position.id,
          "OPEN",
          symbol,
          side,
          amount,
          price,
          new Error(
            `venue reports ${actualLeverage.toFixed(2)}x but ` +
              `${this.config.execution.leverage}x was requested`,
          ),
        );

        if (filled > OWNERSHIP_EPSILON) {
          await this.emergencyClose(
            position,
            symbol,
            position.direction,
            filled,
            "LEVERAGE_MISMATCH",
          );
        }

        await this.recordOwnership({
          paperPositionId: position.id,
          symbol,
          side: position.direction,
          requestedAmount: amount,
          filledAmount: filled,
          closedAmount: filled,
          averagePrice,
          orderId: reference,
          status: filled > OWNERSHIP_EPSILON ? "CLOSED" : "UNVERIFIED",
          now: this.now(),
        });
        return;
      }

      await this.record({
        paperPositionId: position.id,
        action: "OPEN",
        symbol,
        side,
        amount,
        price,
        orderId: reference,
        status: orderAuditStatus(order),
        requestedAmount: amount,
        filledAmount: filled,
        remainingAmount: Math.max(0, amount - filled),
        averagePrice,
        txHash: reference,
      });

      await this.recordOwnership({
        paperPositionId: position.id,
        symbol,
        side: position.direction,
        requestedAmount: amount,
        filledAmount: filled,
        closedAmount: 0,
        averagePrice,
        orderId: reference,
        status: filled > OWNERSHIP_EPSILON ? "OPEN" : "UNVERIFIED",
        now: this.now(),
      });

      this.log(
        `[EXEC] OPEN ${symbol} ${side.toUpperCase()} ${amount} @ worst ${price.toFixed(4)} ` +
          `| ${this.config.execution.leverage}x ${this.config.execution.marginMode} ` +
          `| order ${reference ?? "?"} ${orderAuditStatus(order)} ` +
          `| filled ${filled}/${amount}`,
      );

      if (filled <= OWNERSHIP_EPSILON) {
        this.log(
          `[EXEC] WARN ${symbol} entry is UNVERIFIED: no fill was observed, so ` +
            `the bot will not close this position. Check the venue manually.`,
        );
      }
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

    const fallbackSide = position.direction === "long" ? "sell" : "buy";
    let side: "buy" | "sell" = fallbackSide;
    let amount = 0;
    let price: number | null = null;

    try {
      // Ownership is the hard gate: no verified OPEN record, no close. This is
      // what keeps a manual position, or one opened by another process on the
      // same account, untouched even when the symbol and side match.
      const owned = await this.loadOwnership(position.id);
      if (!owned || owned.status !== "OPEN") {
        await this.skip(
          position,
          symbol,
          fallbackSide,
          `no verified bot ownership for paper position ${position.id} ` +
            `(${owned?.status ?? "missing"}); refusing to close`,
          "CLOSE",
        );
        return;
      }

      const ownedRemaining = owned.filledAmount - owned.closedAmount;
      if (ownedRemaining <= OWNERSHIP_EPSILON) {
        await this.skip(
          position,
          symbol,
          fallbackSide,
          `bot-owned size is already closed`,
          "CLOSE",
        );
        return;
      }

      const held = (await this.positionsFor(symbol)).find(
        (candidate) => candidate.side === owned.side,
      );

      // The venue is already flat (or only an unowned position remains). Never
      // send a reduce-only order for something the bot does not own.
      if (!held) {
        const other = (await this.positionsFor(symbol))[0];
        if (other) {
          await this.skip(
            position,
            symbol,
            fallbackSide,
            `venue position is ${other.side}, but the bot owns ${owned.side}; ` +
              `refusing to close an external position`,
            "CLOSE",
          );
        } else {
          await this.markOwnershipClosed(position.id, "CLOSE");
          await this.skip(
            position,
            symbol,
            fallbackSide,
            `nothing to close on the venue (${exitReason})`,
            "CLOSE",
          );
        }
        return;
      }

      const venueAmount = Math.abs(held.contracts);
      // Close only the bot-owned size. If the venue position is larger, the
      // excess belongs to someone else and stays untouched.
      amount = Math.min(ownedRemaining, venueAmount);
      side = owned.side === "long" ? "sell" : "buy";

      if (venueAmount > ownedRemaining + OWNERSHIP_EPSILON) {
        this.log(
          `[EXEC] WARN ${symbol} venue holds ${venueAmount}, bot owns ` +
            `${ownedRemaining}; closing only the owned size`,
        );
      }

      price = await this.worstPrice(symbol, side);
      if (price === null) {
        throw new Error(`no usable ${side} price for ${symbol}`);
      }

      const order = await this.adapter.createOrder({
        symbol,
        type: "market",
        side,
        amount,
        price,
        reduceOnly: true,
      });

      const reference = orderReference(order);
      await this.record({
        paperPositionId: position.id,
        action: "CLOSE",
        symbol,
        side,
        amount,
        price,
        orderId: reference,
        status: orderAuditStatus(order),
        requestedAmount: amount,
        filledAmount: amount,
        remainingAmount: Math.max(0, ownedRemaining - amount),
        averagePrice: order.price ?? price,
        txHash: reference,
      });

      this.log(
        `[EXEC] CLOSE ${symbol} ${side.toUpperCase()} ${amount} (reduce only) ` +
          `@ worst ${price.toFixed(4)} | ${exitReason} | ` +
          `order ${reference ?? "?"} ${orderAuditStatus(order)}`,
      );

      const stillOpen = await this.verifyClosed(symbol, owned.side);
      if (!stillOpen) {
        await this.markOwnershipClosed(position.id, "CLOSE");
      }
      // A partially filled close leaves the record OPEN so reconcile retries the
      // remainder; closed_amount is only advanced when the venue confirms flat.
    } catch (error) {
      await this.recordFailure(position.id, "CLOSE", symbol, side, amount, price, error);
      throw error;
    }
  }

  private async mirrorReconcile(
    openPositions: PaperExecutionPosition[],
  ): Promise<void> {
    const paperIds = new Set(openPositions.map((position) => position.id));
    const owned = await this.listOwnership();
    const openOwned = owned.filter(
      (entry) =>
        entry.status === "OPEN" &&
        entry.filledAmount - entry.closedAmount > OWNERSHIP_EPSILON,
    );

    // Symbols come from the ownership registry as well as the current config,
    // so removing a symbol from LIGHTER_EXECUTION_SYMBOLS cannot strand a
    // position the bot already opened.
    const symbols = new Set<string>();
    for (const base of this.config.execution.symbols) {
      const symbol = this.toVenueSymbol(base);
      if (symbol) symbols.add(symbol);
    }
    for (const entry of openOwned) symbols.add(entry.symbol);

    for (const symbol of symbols) {
      const venue = await this.positionsFor(symbol);
      const ownedHere = openOwned.filter((entry) => entry.symbol === symbol);

      if (venue.length === 0) {
        // Every owned position on this symbol is gone at the venue. Mark it
        // closed so it is not retried forever.
        for (const entry of ownedHere) {
          await this.markOwnershipClosed(entry.paperPositionId, "RECONCILE_CLOSE");
          this.log(
            `[EXEC] RECONCILE ${symbol}: bot-owned position for paper ` +
              `${entry.paperPositionId} is flat on the venue`,
          );
        }
        continue;
      }

      for (const held of venue) {
        if (Math.abs(held.contracts) <= OWNERSHIP_EPSILON) continue;

        const match = ownedHere.find((entry) => entry.side === held.side);
        if (!match) {
          // No ownership record on this side: this is a manual or external
          // position. Never close it.
          if (!this.missingLogged.has(`${symbol}:${held.side}`)) {
            this.missingLogged.add(`${symbol}:${held.side}`);
            this.log(
              `[EXEC] ${symbol} ${held.side} ${Math.abs(held.contracts)} is not ` +
                `owned by this bot; leaving it untouched`,
            );
          }
          continue;
        }
        this.missingLogged.delete(`${symbol}:${held.side}`);

        if (paperIds.has(match.paperPositionId)) {
          // Paper still tracks the position; it is in sync.
          continue;
        }

        const remaining = match.filledAmount - match.closedAmount;
        const amount = Math.min(remaining, Math.abs(held.contracts));
        if (!(amount > OWNERSHIP_EPSILON)) continue;

        const side = match.side === "long" ? "sell" : "buy";
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

        const reference = orderReference(order);
        await this.record({
          paperPositionId: match.paperPositionId,
          action: "RECONCILE_CLOSE",
          symbol,
          side,
          amount,
          price,
          orderId: reference,
          status: orderAuditStatus(order),
          requestedAmount: amount,
          filledAmount: amount,
          remainingAmount: Math.max(0, remaining - amount),
          averagePrice: order.price ?? price,
          txHash: reference,
        });

        this.log(
          `[EXEC] RECONCILE closed bot-owned ${symbol} ${side.toUpperCase()} ` +
            `${amount} (paper ${match.paperPositionId} is closed) ` +
            `| order ${reference ?? "?"} ${orderAuditStatus(order)}`,
        );

        const stillOpen = await this.verifyClosed(symbol, match.side);
        if (!stillOpen) {
          await this.markOwnershipClosed(match.paperPositionId, "RECONCILE_CLOSE");
        }
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

  /**
   * Free USDC collateral, or null when the venue does not report it. Callers
   * must treat null as "do not trade": the margin check cannot run.
   */
  private async freeUsdc(): Promise<number | null> {
    const balances = await this.adapter.getBalance();
    const usdc = balances.find((entry) => entry.currency.toUpperCase() === "USDC");
    return usdc && Number.isFinite(usdc.free) ? usdc.free : null;
  }

  /** Logs and audits a deliberate no-op so it is never mistaken for a fill. */
  private async skip(
    position: PaperExecutionPosition,
    symbol: string,
    side: string,
    reason: string,
    action: ExecutionAction = "OPEN",
  ): Promise<void> {
    this.log(`[EXEC] ${action} ${symbol} skipped: ${reason}`);
    await this.record({
      paperPositionId: position.id,
      action: "SKIPPED",
      symbol,
      side,
      amount: 0,
      price: null,
      orderId: null,
      status: `SKIPPED_${action}`,
      error: reason.slice(0, 1_000),
    }).catch(() => undefined);
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
  ): Promise<{
    filled: number;
    entryPrice: number | null;
    leverage: number | null;
  }> {
    await this.sleep(DEFAULT_SLEEP_MS);
    const held = (await this.positionsFor(symbol)).find(
      (position) => position.side === direction,
    );

    if (!held) {
      this.log(
        `[EXEC] WARN ${symbol} ${direction} did not appear on the venue after ` +
          `${DEFAULT_SLEEP_MS}ms; the testnet book may be too thin to fill`,
      );
      return { filled: 0, entryPrice: null, leverage: null };
    }

    const filled = Math.abs(held.contracts);
    if (filled + Number.EPSILON < expected) {
      this.log(
        `[EXEC] WARN ${symbol} partial fill: ${filled} of ${expected}`,
      );
    }
    return {
      filled,
      entryPrice: Number.isFinite(held.entryPrice) ? held.entryPrice : null,
      leverage: Number.isFinite(held.leverage) ? held.leverage : null,
    };
  }

  /** Returns true when a position on the given side is still open. */
  private async verifyClosed(
    symbol: string,
    side?: "long" | "short",
  ): Promise<boolean> {
    await this.sleep(DEFAULT_SLEEP_MS);
    const held = (await this.positionsFor(symbol)).filter(
      (position) => side === undefined || position.side === side,
    );

    if (held.length > 0) {
      this.log(
        `[EXEC] WARN ${symbol} still shows ${held[0]!.contracts} after the close order`,
      );
    }

    return held.length > 0;
  }

  /** Unwinds a position the bot just opened when a risk check fails. */
  private async emergencyClose(
    position: PaperExecutionPosition,
    symbol: string,
    ownedSide: "long" | "short",
    amount: number,
    reason: string,
  ): Promise<void> {
    const closeSide = ownedSide === "long" ? "sell" : "buy";
    const price = await this.worstPrice(symbol, closeSide);
    if (price === null) {
      this.log(
        `[EXEC] ERROR ${symbol} ${reason}: no usable ${closeSide} price to unwind`,
      );
      return;
    }

    const order = await this.adapter.createOrder({
      symbol,
      type: "market",
      side: closeSide,
      amount,
      price,
      reduceOnly: true,
    });

    const reference = orderReference(order);
    await this.record({
      paperPositionId: position.id,
      action: "CLOSE",
      symbol,
      side: closeSide,
      amount,
      price,
      orderId: reference,
      status: orderAuditStatus(order),
      error: `risk unwind: ${reason}`,
      requestedAmount: amount,
      filledAmount: amount,
      remainingAmount: 0,
      averagePrice: order.price ?? price,
      txHash: reference,
    }).catch(() => undefined);

    this.log(
      `[EXEC] ERROR ${symbol} ${reason}; unwinding ${amount} ` +
        `| order ${reference ?? "?"} ${orderAuditStatus(order)}`,
    );

    await this.verifyClosed(symbol, ownedSide);
  }

  // -------------------------------------------------------------------------
  // Ownership registry
  // -------------------------------------------------------------------------

  private async loadOwnership(
    paperPositionId: string,
  ): Promise<OwnedVenuePosition | null> {
    const result = await this.readRows(
      "SELECT * FROM lighter_owned_positions WHERE paper_position_id = ?",
      [paperPositionId],
    );
    return result.length > 0 ? this.toOwnership(result[0]!) : null;
  }

  private async listOwnership(): Promise<OwnedVenuePosition[]> {
    const result = await this.readRows(
      "SELECT * FROM lighter_owned_positions ORDER BY created_at",
    );
    return result.map((row) => this.toOwnership(row));
  }

  private toOwnership(row: Record<string, unknown>): OwnedVenuePosition {
    return {
      paperPositionId: String(row.paper_position_id),
      symbol: String(row.symbol),
      side: String(row.side) === "short" ? "short" : "long",
      requestedAmount: Number(row.requested_amount ?? 0),
      filledAmount: Number(row.filled_amount ?? 0),
      closedAmount: Number(row.closed_amount ?? 0),
      averagePrice:
        row.average_price === null || row.average_price === undefined
          ? null
          : Number(row.average_price),
      orderId: row.order_id === null ? null : String(row.order_id),
      status:
        row.status === "CLOSED"
          ? "CLOSED"
          : row.status === "UNVERIFIED"
            ? "UNVERIFIED"
            : "OPEN",
    };
  }

  private async recordOwnership(entry: {
    paperPositionId: string;
    symbol: string;
    side: "long" | "short";
    requestedAmount: number;
    filledAmount: number;
    closedAmount: number;
    averagePrice: number | null;
    orderId: string | null;
    status: "OPEN" | "CLOSED" | "UNVERIFIED";
    now: number;
  }): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, average_price, order_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (paper_position_id) DO UPDATE SET
           requested_amount = excluded.requested_amount,
           filled_amount = excluded.filled_amount,
           closed_amount = excluded.closed_amount,
           average_price = excluded.average_price,
           order_id = excluded.order_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        [
          entry.paperPositionId,
          entry.symbol,
          entry.side,
          entry.requestedAmount,
          entry.filledAmount,
          entry.closedAmount,
          entry.averagePrice,
          entry.orderId,
          entry.status,
          entry.now,
          entry.now,
        ],
      ),
    );
  }

  private async markOwnershipClosed(
    paperPositionId: string,
    _reason: string,
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET closed_amount = filled_amount, status = 'CLOSED', updated_at = ?
         WHERE paper_position_id = ?`,
        [this.now(), paperPositionId],
      ),
    );
  }

  /** Closes every position the registry proves the bot owns. */
  private async flattenOwned(action: ExecutionAction): Promise<void> {
    const owned = (await this.listOwnership()).filter(
      (entry) =>
        entry.status === "OPEN" &&
        entry.filledAmount - entry.closedAmount > OWNERSHIP_EPSILON,
    );

    for (const entry of owned) {
      const remaining = entry.filledAmount - entry.closedAmount;
      const held = (await this.positionsFor(entry.symbol)).find(
        (position) => position.side === entry.side,
      );

      if (!held) {
        await this.markOwnershipClosed(entry.paperPositionId, action);
        continue;
      }

      const amount = Math.min(remaining, Math.abs(held.contracts));
      if (!(amount > OWNERSHIP_EPSILON)) continue;

      const side = entry.side === "long" ? "sell" : "buy";
      const price = await this.worstPrice(entry.symbol, side);
      if (price === null) {
        this.log(
          `[EXEC] ${action} ${entry.symbol} skipped: no usable ${side} price`,
        );
        continue;
      }

      const order = await this.adapter.createOrder({
        symbol: entry.symbol,
        type: "market",
        side,
        amount,
        price,
        reduceOnly: true,
      });

      const reference = orderReference(order);
      await this.record({
        paperPositionId: entry.paperPositionId,
        action,
        symbol: entry.symbol,
        side,
        amount,
        price,
        orderId: reference,
        status: orderAuditStatus(order),
        requestedAmount: amount,
        filledAmount: amount,
        remainingAmount: Math.max(0, remaining - amount),
        averagePrice: order.price ?? price,
        txHash: reference,
      });

      this.log(
        `[EXEC] ${action} ${entry.symbol} ${side.toUpperCase()} ${amount} ` +
          `(reduce only) | paper ${entry.paperPositionId} ` +
          `| order ${reference ?? "?"} ${orderAuditStatus(order)}`,
      );

      const stillOpen = await this.verifyClosed(entry.symbol, entry.side);
      if (!stillOpen) {
        await this.markOwnershipClosed(entry.paperPositionId, action);
      }
    }
  }

  private async readRows(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    return withSerializedDatabaseOperation(async () => {
      const result = await this.connection.runAndReadAll(sql, params as any[]);
      return result.getRowObjects() as Array<Record<string, unknown>>;
    });
  }

  private enqueue(task: () => Promise<void>, label: string): void {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => {
        this.log(`[EXEC] ${label} failed: ${this.adapter.redact(error)}`);
      });
  }

  private async ensureAuditTable(): Promise<void> {
    await withSerializedDatabaseOperation(async () => {
      await this.connection.run(`
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
      `);

      // Fill-level columns were added after the first testnet run; the
      // migration keeps existing local databases usable.
      for (const column of [
        "requested_amount DOUBLE",
        "filled_amount DOUBLE",
        "remaining_amount DOUBLE",
        "average_price DOUBLE",
        "tx_hash VARCHAR",
      ]) {
        await this.connection.run(
          `ALTER TABLE lighter_executions ADD COLUMN IF NOT EXISTS ${column}`,
        );
      }

      // Ownership is the only proof that a venue position may be closed.
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS lighter_owned_positions (
          paper_position_id VARCHAR PRIMARY KEY,
          symbol VARCHAR NOT NULL,
          side VARCHAR NOT NULL,
          requested_amount DOUBLE NOT NULL,
          filled_amount DOUBLE NOT NULL,
          closed_amount DOUBLE NOT NULL,
          average_price DOUBLE,
          order_id VARCHAR,
          status VARCHAR NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
    });
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
    requestedAmount?: number;
    filledAmount?: number;
    remainingAmount?: number;
    averagePrice?: number | null;
    txHash?: string | null;
  }): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `INSERT INTO lighter_executions
         (id, paper_position_id, action, symbol, side, amount, price, order_id,
          status, error, created_at, requested_amount, filled_amount,
          remaining_amount, average_price, tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          entry.requestedAmount ?? null,
          entry.filledAmount ?? null,
          entry.remainingAmount ?? null,
          entry.averagePrice ?? null,
          entry.txHash ?? null,
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
