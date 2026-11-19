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
  /**
   * OPEN = verified and manageable. UNVERIFIED = never claim it.
   * UNWIND_PENDING = a risk check failed after the fill; reconcile must close
   * it even while paper still shows the position as open.
   */
  status: "OPEN" | "CLOSED" | "UNVERIFIED" | "UNWIND_PENDING";
}

/** Amounts below this are treated as fully closed (venue size steps). */
const OWNERSHIP_EPSILON = 1e-9;

/** Attempts for a shutdown flatten, with a pause between them. */
const SHUTDOWN_FLATTEN_ATTEMPTS = 3;

/** Audit status for one closing order, based on observed fills. */
export type CloseFillStatus =
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "UNKNOWN"
  | "REJECTED";

interface CloseOutcome {
  filled: number;
  /** Contracts still open on the owned side after the order. */
  remaining: number;
  status: CloseFillStatus;
  price: number | null;
  side: "buy" | "sell";
  reference: string | null;
}

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
        const residual = await this.flattenOwned("SHUTDOWN_CLOSE");
        if (residual.length > 0) {
          const detail = residual
            .map(
              (entry) =>
                `${entry.symbol} ${entry.side} ` +
                `${entry.filledAmount - entry.closedAmount}`,
            )
            .join(", ");
          this.log(
            `[EXEC] ERROR shutdown left bot-owned positions open: ${detail}. ` +
              `The venue is still exposed; close them manually.`,
          );
        } else {
          this.log("[EXEC] shutdown flatten complete: no bot-owned positions left");
        }
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

      // Claim the fill before any other risk check runs. If the unwind below
      // fails, the ownership row is what lets reconcile finish the job.
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

      // The venue's reported leverage is derived from the position's initial
      // margin fraction. If it exceeds the configured value the liquidation
      // guard no longer holds, so unwind immediately. Ownership only becomes
      // CLOSED once the venue confirms the position is flat.
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
          await this.markOwnershipStatus(position.id, "UNWIND_PENDING");

          // Each attempt re-reads the venue position and advances ownership by
          // the confirmed fill only. If the venue stays exposed, the row stays
          // UNWIND_PENDING so reconcile retries it even while paper is open.
          let remaining = filled;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const outcome = await this.closeOwned({
              paperPositionId: position.id,
              symbol,
              ownedSide: position.direction,
              amount: remaining,
              reason: "LEVERAGE_MISMATCH",
              action: "CLOSE",
            });

            if (outcome.filled > OWNERSHIP_EPSILON) {
              await this.addOwnershipClosed(position.id, outcome.filled);
            }

            remaining = outcome.remaining;
            if (remaining <= OWNERSHIP_EPSILON) {
              await this.markOwnershipClosed(position.id, "CLOSE");
              this.log(
                `[EXEC] ${symbol} leverage mismatch unwound on attempt ${attempt}`,
              );
              return;
            }

            if (attempt < 2) await this.sleep(DEFAULT_SLEEP_MS);
          }

          this.log(
            `[EXEC] ERROR ${symbol} leverage mismatch is UNRESOLVED ` +
              `(${remaining} still open at ${actualLeverage.toFixed(2)}x); ` +
              `ownership stays UNWIND_PENDING and reconcile will retry`,
          );
          return;
        }
      }

      if (actualLeverage === null) {
        this.log(
          `[EXEC] WARN ${symbol} venue did not report leverage; the ${this.config.execution.leverage}x ` +
            `request was accepted, but the applied value is unverified`,
        );
      }

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
      // Ownership is the hard gate: no verified record, no close. This keeps a
      // manual position, or one opened by another process on the same account,
      // untouched even when symbol and side match.
      const owned = await this.loadOwnership(position.id);
      if (
        !owned ||
        (owned.status !== "OPEN" && owned.status !== "UNWIND_PENDING")
      ) {
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
      amount = Math.min(ownedRemaining, venueAmount);
      side = owned.side === "long" ? "sell" : "buy";

      if (venueAmount > ownedRemaining + OWNERSHIP_EPSILON) {
        this.log(
          `[EXEC] WARN ${symbol} venue holds ${venueAmount}, bot owns ` +
            `${ownedRemaining}; closing only the owned size`,
        );
      }

      const outcome = await this.closeOwned({
        paperPositionId: position.id,
        symbol,
        ownedSide: owned.side,
        amount,
        reason: exitReason,
        action: "CLOSE",
      });

      price = outcome.price;
      side = outcome.side;

      // Advance ownership only by the amount the venue actually closed.
      if (outcome.filled > OWNERSHIP_EPSILON) {
        await this.addOwnershipClosed(position.id, outcome.filled);
      }
      if (outcome.remaining <= OWNERSHIP_EPSILON) {
        await this.markOwnershipClosed(position.id, "CLOSE");
      }
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
        (entry.status === "OPEN" || entry.status === "UNWIND_PENDING") &&
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

      // An owned record whose side is no longer on the venue is flat: the exit
      // filled, or someone closed it by hand. Mark it closed so it is not
      // retried every interval. This is checked per entry, so an unrelated
      // position on the other side does not keep the record alive.
      for (const entry of ownedHere) {
        const present = venue.some(
          (held) =>
            held.side === entry.side &&
            Math.abs(held.contracts) > OWNERSHIP_EPSILON,
        );
        if (present) continue;

        await this.markOwnershipClosed(entry.paperPositionId, "RECONCILE_CLOSE");
        this.log(
          `[EXEC] RECONCILE ${symbol}: bot-owned ${entry.side} for paper ` +
            `${entry.paperPositionId} is flat on the venue`,
        );
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

        // UNWIND_PENDING is always closed, even while paper still shows the
        // position open, because a risk check already failed.
        if (
          match.status === "OPEN" &&
          paperIds.has(match.paperPositionId)
        ) {
          continue;
        }

        const remaining = match.filledAmount - match.closedAmount;
        const amount = Math.min(remaining, Math.abs(held.contracts));
        if (!(amount > OWNERSHIP_EPSILON)) continue;

        const outcome = await this.closeOwned({
          paperPositionId: match.paperPositionId,
          symbol,
          ownedSide: match.side,
          amount,
          reason:
            match.status === "UNWIND_PENDING"
              ? "UNWIND_PENDING"
              : "paper position ended",
          action: "RECONCILE_CLOSE",
        });

        if (outcome.filled > OWNERSHIP_EPSILON) {
          await this.addOwnershipClosed(match.paperPositionId, outcome.filled);
        }
        if (outcome.remaining <= OWNERSHIP_EPSILON) {
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

  /** Contracts still open on the given side after the settle delay. */
  private async verifyClose(
    symbol: string,
    side: "long" | "short",
  ): Promise<number> {
    await this.sleep(DEFAULT_SLEEP_MS);
    return (await this.positionsFor(symbol))
      .filter((position) => position.side === side)
      .reduce((total, position) => total + Math.abs(position.contracts), 0);
  }

  /**
   * Sends one reduce-only close and reports what actually happened. Ownership
   * is advanced only from `filled`, which is measured against the venue
   * position before and after the order rather than assumed.
   */
  private async closeOwned(input: {
    paperPositionId: string;
    symbol: string;
    ownedSide: "long" | "short";
    amount: number;
    reason: string;
    action: ExecutionAction;
  }): Promise<CloseOutcome> {
    const closeSide = input.ownedSide === "long" ? "sell" : "buy";
    const before = (await this.positionsFor(input.symbol))
      .filter((position) => position.side === input.ownedSide)
      .reduce((total, position) => total + Math.abs(position.contracts), 0);

    if (!(input.amount > OWNERSHIP_EPSILON) || before <= OWNERSHIP_EPSILON) {
      return {
        filled: 0,
        remaining: before,
        status: before <= OWNERSHIP_EPSILON ? "FILLED" : "UNKNOWN",
        price: null,
        side: closeSide,
        reference: null,
      };
    }

    const price = await this.worstPrice(input.symbol, closeSide);
    if (price === null) {
      this.log(
        `[EXEC] ${input.action} ${input.symbol} skipped: no usable ` +
          `${closeSide} price (${input.reason})`,
      );
      return {
        filled: 0,
        remaining: before,
        status: "UNKNOWN",
        price: null,
        side: closeSide,
        reference: null,
      };
    }

    const order = await this.adapter.createOrder({
      symbol: input.symbol,
      type: "market",
      side: closeSide,
      amount: input.amount,
      price,
      reduceOnly: true,
    });

    const reference = orderReference(order);
    const after = await this.verifyClose(input.symbol, input.ownedSide);
    const filled = Math.max(0, Math.min(input.amount, before - after));
    const status = this.closeFillStatus(order, filled, input.amount);
    const averagePrice = order.average ?? null;

    await this.record({
      paperPositionId: input.paperPositionId,
      action: input.action,
      symbol: input.symbol,
      side: closeSide,
      amount: input.amount,
      price,
      orderId: reference,
      status,
      requestedAmount: input.amount,
      filledAmount: filled,
      remainingAmount: Math.max(0, input.amount - filled),
      averagePrice,
      txHash: reference,
    });

    this.log(
      `[EXEC] ${input.action} ${input.symbol} ${closeSide.toUpperCase()} ` +
        `${filled}/${input.amount} (reduce only) @ worst ${price.toFixed(4)} | ` +
        `${input.reason} | order ${reference ?? "?"} ${status} | remaining ${after}`,
    );

    return {
      filled,
      remaining: after,
      status,
      price,
      side: closeSide,
      reference,
    };
  }

  private closeFillStatus(
    order: Order,
    filled: number,
    requested: number,
  ): CloseOutcome["status"] {
    if (
      order.status === "rejected" ||
      order.status === "canceled" ||
      order.status === "expired"
    ) {
      return "REJECTED";
    }
    if (filled >= requested - OWNERSHIP_EPSILON) return "FILLED";
    if (filled > OWNERSHIP_EPSILON) return "PARTIALLY_FILLED";
    return "UNKNOWN";
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
            : row.status === "UNWIND_PENDING"
              ? "UNWIND_PENDING"
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
    status: "OPEN" | "CLOSED" | "UNVERIFIED" | "UNWIND_PENDING";
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

  /** Advances the closed amount by a confirmed fill, capping at the fill. */
  private async addOwnershipClosed(
    paperPositionId: string,
    amount: number,
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET closed_amount = LEAST(filled_amount, closed_amount + ?),
             status = CASE
               WHEN closed_amount + ? >= filled_amount - ? THEN 'CLOSED'
               ELSE status
             END,
             updated_at = ?
         WHERE paper_position_id = ?`,
        [amount, amount, OWNERSHIP_EPSILON, this.now(), paperPositionId],
      ),
    );
  }

  /** Moves an ownership row between OPEN, UNWIND_PENDING and CLOSED. */
  private async markOwnershipStatus(
    paperPositionId: string,
    status: OwnedVenuePosition["status"],
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET status = ?, updated_at = ?
         WHERE paper_position_id = ?`,
        [status, this.now(), paperPositionId],
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
  /**
   * Closes every position the registry proves the bot owns.
   *
   * Each position gets a bounded number of attempts: the venue is re-read, the
   * remaining owned size is recomputed, and a fresh price is taken before each
   * order. Returns the positions that could not be flattened, so `close()` can
   * state explicitly that the venue is still exposed.
   */
  private async flattenOwned(
    action: ExecutionAction,
  ): Promise<OwnedVenuePosition[]> {
    const owned = (await this.listOwnership()).filter(
      (entry) =>
        (entry.status === "OPEN" || entry.status === "UNWIND_PENDING") &&
        entry.filledAmount - entry.closedAmount > OWNERSHIP_EPSILON,
    );
    const residual: OwnedVenuePosition[] = [];

    for (const entry of owned) {
      let unresolved = true;

      for (let attempt = 1; attempt <= SHUTDOWN_FLATTEN_ATTEMPTS; attempt++) {
        const remaining = entry.filledAmount - entry.closedAmount;
        const held = (await this.positionsFor(entry.symbol)).find(
          (position) => position.side === entry.side,
        );

        if (!held || !(remaining > OWNERSHIP_EPSILON)) {
          await this.markOwnershipClosed(entry.paperPositionId, action);
          unresolved = false;
          break;
        }

        const amount = Math.min(remaining, Math.abs(held.contracts));
        const outcome = await this.closeOwned({
          paperPositionId: entry.paperPositionId,
          symbol: entry.symbol,
          ownedSide: entry.side,
          amount,
          reason: "shutdown",
          action,
        });

        if (outcome.filled > OWNERSHIP_EPSILON) {
          await this.addOwnershipClosed(entry.paperPositionId, outcome.filled);
        }

        if (outcome.remaining <= OWNERSHIP_EPSILON) {
          await this.markOwnershipClosed(entry.paperPositionId, action);
          unresolved = false;
          break;
        }

        this.log(
          `[EXEC] ${action} ${entry.symbol} attempt ${attempt}/${SHUTDOWN_FLATTEN_ATTEMPTS} ` +
            `left ${outcome.remaining}; retrying`,
        );
        if (attempt < SHUTDOWN_FLATTEN_ATTEMPTS) {
          await this.sleep(DEFAULT_SLEEP_MS);
        }
      }

      if (unresolved) {
        const current = await this.loadOwnership(entry.paperPositionId);
        if (current) residual.push(current);
        this.log(
          `[EXEC] ERROR ${action} could not flatten ${entry.symbol} ` +
            `(paper ${entry.paperPositionId}); venue position remains open`,
        );
      }
    }

    return residual;
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
