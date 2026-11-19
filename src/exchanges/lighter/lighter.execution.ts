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
 * Ownership lifecycle of a venue position, keyed by the paper position that
 * caused it. A venue position is never closed unless a matching `OPEN` or
 * `UNWIND_PENDING` row exists here with a positive remaining size.
 *
 * PENDING        = entry intent is durable, but the venue has not been observed
 *                  to confirm the fill yet (submitted, acknowledgement lost, or
 *                  the position endpoint was unavailable). Reconcile resolves it.
 * OPEN           = fill observed and manageable.
 * UNWIND_PENDING = a risk check failed after the fill; reconcile must close it
 *                  even while paper still shows the position as open.
 * UNVERIFIED     = the order was acknowledged but no fill was observed, so the
 *                  bridge will not claim the position.
 * CLOSED         = no remaining owned size.
 */
export type OwnershipStatus =
  | "PENDING"
  | "OPEN"
  | "UNWIND_PENDING"
  | "UNVERIFIED"
  | "CLOSED";

/**
 * How far the entry got. Kept separate from `status` so a lost acknowledgement
 * or a failed position read is visible without discarding the ownership trail.
 */
export type EntryConfirmation =
  | "INTENT"
  | "ACKNOWLEDGED"
  | "CONFIRMED"
  | "FAILED"
  | "UNRESOLVED";

/** Who removed the owned size: this bot, or a manual/external action. */
export type CloseAttribution = "BOT" | "EXTERNAL";

export interface OwnedVenuePosition {
  paperPositionId: string;
  symbol: string;
  side: "long" | "short";
  requestedAmount: number;
  filledAmount: number;
  /** botClosedAmount + externalClosedAmount. */
  closedAmount: number;
  /** Quantity this bot closed with its own reduce-only orders. */
  botClosedAmount: number;
  /** Quantity found flat on the venue without a bot close order. */
  externalClosedAmount: number;
  /**
   * Historical closed size recorded before attribution existed. Kept so
   * closedAmount is never silently larger than the two attributed buckets.
   */
  legacyClosedAmount: number;
  averagePrice: number | null;
  orderId: string | null;
  status: OwnershipStatus;
  confirmation: EntryConfirmation;
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
  /**
   * True when no bot order was sent because the venue position was already
   * flat. The size disappeared through a manual or external action and must not
   * be counted as a bot fill.
   */
  alreadyFlat: boolean;
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
            .map((entry) =>
              entry.status === "PENDING"
                ? `${entry.symbol} ${entry.side} pending entry ` +
                  `(order ${entry.orderId ?? "unknown"})`
                : `${entry.symbol} ${entry.side} ` +
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

      // Durable entry intent before the order leaves the process. If the
      // process or the database dies after the venue accepts the entry, this
      // row is what lets reconcile match venue state; ownership is never
      // inferred from a position that appears without an intent.
      await this.recordOwnership({
        paperPositionId: position.id,
        symbol,
        side: position.direction,
        requestedAmount: amount,
        filledAmount: 0,
        closedAmount: 0,
        botClosedAmount: 0,
        externalClosedAmount: 0,
        legacyClosedAmount: 0,
        averagePrice: price,
        orderId: null,
        status: "PENDING",
        confirmation: "INTENT",
        now: this.now(),
      });

      let order: Order;
      try {
        order = await this.adapter.createOrder({
          symbol,
          type: "market",
          side,
          amount,
          price,
        });
      } catch (error) {
        // The signed order may have reached the venue even though the call
        // failed. Keep the intent visible so reconcile can check the market
        // instead of dropping the trail.
        await this.setEntryConfirmation(position.id, "UNRESOLVED");
        throw error;
      }

      const reference = orderReference(order);
      await this.acknowledgeOwnership(position.id, reference);

      let verification: {
        filled: number;
        entryPrice: number | null;
        leverage: number | null;
      } | null = null;
      try {
        verification = await this.verifyOpen(
          symbol,
          position.direction,
          amount,
        );
      } catch (error) {
        // A fill is only claimed from an observed venue position. Without that
        // read the intent stays PENDING and reconcile adopts the position when
        // the endpoint recovers.
        await this.setEntryConfirmation(position.id, "UNRESOLVED");
        this.log(
          `[EXEC] WARN ${symbol} order ${reference ?? "?"} was acknowledged but ` +
            `could not be verified (${this.adapter.redact(error)}); ` +
            `ownership stays PENDING for reconcile`,
        );
      }

      if (!verification) {
        await this.record({
          paperPositionId: position.id,
          action: "OPEN",
          symbol,
          side,
          amount,
          price,
          orderId: reference,
          status: "SUBMITTED",
          requestedAmount: amount,
          filledAmount:
            order.filled !== null && order.filled > 0 ? order.filled : 0,
          remainingAmount:
            amount - (order.filled !== null && order.filled > 0 ? order.filled : 0),
          averagePrice: order.average ?? null,
          txHash: reference,
        });
        return;
      }

      const reportedFill =
        order.filled !== null && Number.isFinite(order.filled) && order.filled > 0
          ? order.filled
          : 0;
      const filled = Math.min(
        amount,
        Math.max(reportedFill, verification.filled),
      );
      const averagePrice = verification.entryPrice ?? order.price ?? price;

      // A zero observed fill is only final when the order is terminal. An open
      // order, or a bare acknowledgement (Lighter reports "unknown" for an IOC
      // ack), can still produce a position, so keep the intent PENDING and let
      // reconcile adopt it instead of downgrading it to UNVERIFIED.
      const terminalOrder =
        order.status === "closed" ||
        order.status === "canceled" ||
        order.status === "expired" ||
        order.status === "rejected";
      const stillWorking =
        filled <= OWNERSHIP_EPSILON &&
        !terminalOrder &&
        (order.status === "open" ||
          order.status === "unknown" ||
          (order.remaining !== null && order.remaining > OWNERSHIP_EPSILON));

      if (stillWorking) {
        await this.record({
          paperPositionId: position.id,
          action: "OPEN",
          symbol,
          side,
          amount,
          price,
          orderId: reference,
          status: "SUBMITTED",
          requestedAmount: amount,
          filledAmount: 0,
          remainingAmount:
            order.remaining !== null && order.remaining > 0
              ? order.remaining
              : amount,
          averagePrice: order.average ?? null,
          txHash: reference,
        });

        this.log(
          `[EXEC] WARN ${symbol} entry ${reference ?? "?"} is still working with ` +
            `no observed fill; ownership stays PENDING for reconcile`,
        );
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
        botClosedAmount: 0,
        externalClosedAmount: 0,
        legacyClosedAmount: 0,
        averagePrice,
        orderId: reference,
        status: filled > OWNERSHIP_EPSILON ? "OPEN" : "UNVERIFIED",
        confirmation: "CONFIRMED",
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
      const actualLeverage = verification.leverage;
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
          // The row is already OPEN from the confirmed fill. A failure to mark
          // it pending must not skip the unwind or the alert below.
          await this
            .markOwnershipStatus(position.id, "UNWIND_PENDING")
            .catch((error) => {
              this.log(
                `[EXEC] ERROR ${symbol} could not mark ownership UNWIND_PENDING: ` +
                  `${this.adapter.redact(error)}`,
              );
            });

          // Each attempt re-reads the venue position and advances ownership by
          // the confirmed fill only. A thrown order or price error is caught
          // here so the remaining attempts still run and the alert below is
          // always emitted.
          let remaining = filled;
          let unresolvedReason = `${remaining} still open`;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const outcome = await this.closeOwned({
                paperPositionId: position.id,
                symbol,
                ownedSide: position.direction,
                amount: remaining,
                reason: "LEVERAGE_MISMATCH",
                action: "CLOSE",
              });

              if (outcome.filled > OWNERSHIP_EPSILON) {
                await this.addOwnershipClosed(
                  position.id,
                  outcome.filled,
                  "BOT",
                );
              }

              remaining = outcome.remaining;
              if (remaining <= OWNERSHIP_EPSILON) {
                await this.markOwnershipClosed(
                  position.id,
                  "CLOSE",
                  outcome.alreadyFlat ? "EXTERNAL" : "BOT",
                );
                this.log(
                  `[EXEC] ${symbol} leverage mismatch unwound on attempt ${attempt}`,
                );
                return;
              }

              unresolvedReason = `${remaining} still open`;
            } catch (error) {
              unresolvedReason =
                `attempt ${attempt} threw: ${this.adapter.redact(error)}`;
              this.log(
                `[EXEC] ERROR ${symbol} leverage mismatch unwind attempt ` +
                  `${attempt} failed: ${this.adapter.redact(error)}`,
              );
            }

            if (attempt < 2) await this.sleep(DEFAULT_SLEEP_MS);
          }

          // Unconditional, whether the last attempt returned a residual size
          // or threw: the venue is still exposed at the wrong leverage.
          this.log(
            `[EXEC] ERROR ${symbol} leverage mismatch is UNRESOLVED ` +
              `(${unresolvedReason} at ${actualLeverage.toFixed(2)}x); ` +
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
          // The venue is flat but no close order was sent: the size left
          // through a manual action or another process.
          await this.markOwnershipClosed(position.id, "CLOSE", "EXTERNAL");
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
        await this.addOwnershipClosed(position.id, outcome.filled, "BOT");
      }
      if (outcome.remaining <= OWNERSHIP_EPSILON) {
        await this.markOwnershipClosed(
          position.id,
          "CLOSE",
          outcome.alreadyFlat ? "EXTERNAL" : "BOT",
        );
      }
    } catch (error) {
      await this.recordFailure(position.id, "CLOSE", symbol, side, amount, price, error);
      throw error;
    }
  }

  /**
   * Resolves one durable entry intent from venue state.
   *
   * ADOPTED  = the venue holds a position; ownership is claimed at the venue
   *            size. WORKING = no position but a resting order, keep waiting.
   * UNFILLED = no position and no order, the entry never happened.
   * DUPLICATE = another owned row already claims this side.
   *
   * Throws when the venue cannot be read, so the caller keeps the intent
   * PENDING instead of discarding the trail.
   */
  private async resolvePendingOwnership(
    entry: OwnedVenuePosition,
    venue: Position[],
    claimedByAnother: boolean,
  ): Promise<{
    row: OwnedVenuePosition | null;
    outcome: "ADOPTED" | "WORKING" | "UNFILLED" | "DUPLICATE";
  }> {
    const held = venue.find(
      (position) =>
        position.side === entry.side &&
        Math.abs(position.contracts) > OWNERSHIP_EPSILON,
    );

    if (held) {
      if (claimedByAnother) {
        await this.markOwnershipStatus(entry.paperPositionId, "CLOSED");
        await this.setEntryConfirmation(entry.paperPositionId, "FAILED");
        return { row: null, outcome: "DUPLICATE" };
      }

      const size = Math.abs(held.contracts);
      const entryPrice = Number.isFinite(held.entryPrice)
        ? held.entryPrice
        : entry.averagePrice;
      await this.adoptOwnership(entry.paperPositionId, size, entryPrice);

      return {
        row: {
          ...entry,
          filledAmount: size,
          averagePrice: entryPrice,
          status: "OPEN",
          confirmation: "CONFIRMED",
        },
        outcome: "ADOPTED",
      };
    }

    const working = await this.adapter.getOpenOrders(entry.symbol);
    if (working.length > 0) return { row: null, outcome: "WORKING" };

    await this.markOwnershipStatus(entry.paperPositionId, "CLOSED");
    await this.setEntryConfirmation(entry.paperPositionId, "FAILED");
    return { row: null, outcome: "UNFILLED" };
  }

  /**
   * Cancels the working entry order for a PENDING intent. Only an order whose
   * id matches the recorded reference, or the single working order on the
   * intent's side, is cancelled. Returns false when the order cannot be
   * identified or is still working after the cancel, so shutdown never assumes
   * that an outstanding entry is gone.
   */
  private async cancelPendingEntry(entry: OwnedVenuePosition): Promise<boolean> {
    const working = await this.adapter.getOpenOrders(entry.symbol);
    if (working.length === 0) return true;

    const intentSide = entry.side === "long" ? "buy" : "sell";
    const candidates = working.filter((order) => order.side === intentSide);
    const byId = entry.orderId
      ? candidates.find((order) => order.id === entry.orderId)
      : undefined;
    // Lighter's acknowledgement is often a transaction hash rather than an
    // order id. With exclusive account use, a single working order on the
    // intent's side can only be the bot's entry.
    const target = byId ?? (candidates.length === 1 ? candidates[0] : undefined);

    if (!target || !target.id) {
      this.log(
        `[EXEC] cannot identify the working entry order on ${entry.symbol} ` +
          `for paper ${entry.paperPositionId}; refusing to cancel`,
      );
      return false;
    }

    await this.adapter.cancelOrder(target.id, entry.symbol);
    this.log(
      `[EXEC] canceled working entry order ${target.id} on ${entry.symbol} ` +
        `for paper ${entry.paperPositionId}`,
    );

    const remaining = await this.adapter.getOpenOrders(entry.symbol);
    return !remaining.some((order) => order.id === target.id);
  }

  private async mirrorReconcile(
    openPositions: PaperExecutionPosition[],
  ): Promise<void> {
    const paperIds = new Set(openPositions.map((position) => position.id));
    const owned = await this.listOwnership();
    const pending = owned.filter((entry) => entry.status === "PENDING");
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
    for (const entry of pending) symbols.add(entry.symbol);

    for (const symbol of symbols) {
      const venue = await this.positionsFor(symbol);

      // Resolve durable entry intents before touching anything else. A position
      // that appeared after the intent was recorded is adopted; an intent with
      // no position and no working order is closed as never filled. A failed
      // venue read throws above and leaves the intent PENDING, so nothing is
      // discarded when the endpoint is unavailable.
      for (const entry of pending.filter((row) => row.symbol === symbol)) {
        const claimedByAnother = openOwned.some(
          (row) => row.symbol === symbol && row.side === entry.side,
        );
        const result = await this.resolvePendingOwnership(
          entry,
          venue,
          claimedByAnother,
        );

        if (result.outcome === "ADOPTED") {
          this.log(
            `[EXEC] RECONCILE ${symbol}: adopted ` +
              `${result.row?.filledAmount ?? 0} ${entry.side} from the venue ` +
              `for pending paper ${entry.paperPositionId}`,
          );
          if (result.row) openOwned.push(result.row);
        } else if (result.outcome === "DUPLICATE") {
          this.log(
            `[EXEC] RECONCILE ${symbol}: pending intent ${entry.paperPositionId} ` +
              `is covered by another owned ${entry.side}; not adopting`,
          );
        } else if (result.outcome === "WORKING") {
          this.log(
            `[EXEC] RECONCILE ${symbol}: pending intent ${entry.paperPositionId} ` +
              `still has a working order; keeping it PENDING`,
          );
        } else {
          this.log(
            `[EXEC] RECONCILE ${symbol}: pending intent ${entry.paperPositionId} ` +
              `never filled on the venue; ownership closed`,
          );
        }
      }

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

        await this.markOwnershipClosed(
          entry.paperPositionId,
          "RECONCILE_CLOSE",
          "EXTERNAL",
        );
        this.log(
          `[EXEC] RECONCILE ${symbol}: bot-owned ${entry.side} for paper ` +
            `${entry.paperPositionId} is flat on the venue (no bot close order)`,
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
          await this.addOwnershipClosed(
            match.paperPositionId,
            outcome.filled,
            "BOT",
          );
        }
        if (outcome.remaining <= OWNERSHIP_EPSILON) {
          await this.markOwnershipClosed(
            match.paperPositionId,
            "RECONCILE_CLOSE",
            outcome.alreadyFlat ? "EXTERNAL" : "BOT",
          );
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
      const alreadyFlat = before <= OWNERSHIP_EPSILON;
      if (alreadyFlat) {
        this.log(
          `[EXEC] ${input.action} ${input.symbol} is already flat on the venue; ` +
            `no close order sent (${input.reason})`,
        );
      }
      return {
        filled: 0,
        remaining: before,
        status: "UNKNOWN",
        price: null,
        side: closeSide,
        reference: null,
        alreadyFlat,
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
        alreadyFlat: false,
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

    await this
      .record({
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
      })
      .catch((error) => {
        // The reduction already happened; ownership must still advance.
        this.log(
          `[EXEC] WARN ${input.symbol} close filled ${filled}/${input.amount} ` +
            `but the audit row could not be written: ${this.adapter.redact(error)}`,
        );
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
      alreadyFlat: false,
    };
  }

  private closeFillStatus(
    order: Order,
    filled: number,
    requested: number,
  ): CloseOutcome["status"] {
    // The measured fill wins over the terminal order status: a canceled or
    // expired order can still have filled part of the size.
    if (filled >= requested - OWNERSHIP_EPSILON) return "FILLED";
    if (filled > OWNERSHIP_EPSILON) return "PARTIALLY_FILLED";
    if (
      order.status === "rejected" ||
      order.status === "canceled" ||
      order.status === "expired"
    ) {
      return "REJECTED";
    }
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
    const status = String(row.status);
    const confirmation = String(row.confirmation ?? "CONFIRMED");

    return {
      paperPositionId: String(row.paper_position_id),
      symbol: String(row.symbol),
      side: String(row.side) === "short" ? "short" : "long",
      requestedAmount: Number(row.requested_amount ?? 0),
      filledAmount: Number(row.filled_amount ?? 0),
      closedAmount: Number(row.closed_amount ?? 0),
      botClosedAmount: Number(row.bot_closed_amount ?? 0),
      externalClosedAmount: Number(row.external_closed_amount ?? 0),
      legacyClosedAmount: Number(row.legacy_closed_amount ?? 0),
      averagePrice:
        row.average_price === null || row.average_price === undefined
          ? null
          : Number(row.average_price),
      orderId: row.order_id === null ? null : String(row.order_id),
      status:
        status === "CLOSED"
          ? "CLOSED"
          : status === "UNVERIFIED"
            ? "UNVERIFIED"
            : status === "UNWIND_PENDING"
              ? "UNWIND_PENDING"
              : status === "PENDING"
                ? "PENDING"
                : "OPEN",
      confirmation:
        confirmation === "INTENT" ||
        confirmation === "ACKNOWLEDGED" ||
        confirmation === "FAILED" ||
        confirmation === "UNRESOLVED"
          ? confirmation
          : "CONFIRMED",
    };
  }

  private async recordOwnership(entry: {
    paperPositionId: string;
    symbol: string;
    side: "long" | "short";
    requestedAmount: number;
    filledAmount: number;
    closedAmount: number;
    botClosedAmount: number;
    externalClosedAmount: number;
    legacyClosedAmount: number;
    averagePrice: number | null;
    orderId: string | null;
    status: OwnershipStatus;
    confirmation: EntryConfirmation;
    now: number;
  }): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (paper_position_id) DO UPDATE SET
           requested_amount = excluded.requested_amount,
           filled_amount = excluded.filled_amount,
           closed_amount = excluded.closed_amount,
           bot_closed_amount = excluded.bot_closed_amount,
           external_closed_amount = excluded.external_closed_amount,
           legacy_closed_amount = excluded.legacy_closed_amount,
           average_price = excluded.average_price,
           order_id = excluded.order_id,
           status = excluded.status,
           confirmation = excluded.confirmation,
           updated_at = excluded.updated_at`,
        [
          entry.paperPositionId,
          entry.symbol,
          entry.side,
          entry.requestedAmount,
          entry.filledAmount,
          entry.closedAmount,
          entry.botClosedAmount,
          entry.externalClosedAmount,
          entry.legacyClosedAmount,
          entry.averagePrice,
          entry.orderId,
          entry.status,
          entry.confirmation,
          entry.now,
          entry.now,
        ],
      ),
    );
  }

  /** Records the venue order reference without claiming a fill yet. */
  private async acknowledgeOwnership(
    paperPositionId: string,
    orderId: string | null,
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET order_id = ?, confirmation = 'ACKNOWLEDGED', updated_at = ?
         WHERE paper_position_id = ?`,
        [orderId, this.now(), paperPositionId],
      ),
    );
  }

  /** Records that the outcome of the submission is not yet known. */
  private async setEntryConfirmation(
    paperPositionId: string,
    confirmation: EntryConfirmation,
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET confirmation = ?, updated_at = ?
         WHERE paper_position_id = ?`,
        [confirmation, this.now(), paperPositionId],
      ),
    );
  }

  /** Adopts a PENDING intent after the venue confirms a position exists. */
  private async adoptOwnership(
    paperPositionId: string,
    filledAmount: number,
    averagePrice: number | null,
  ): Promise<void> {
    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET filled_amount = ?, average_price = COALESCE(?, average_price),
             status = 'OPEN', confirmation = 'CONFIRMED', updated_at = ?
         WHERE paper_position_id = ?`,
        [filledAmount, averagePrice, this.now(), paperPositionId],
      ),
    );
  }

  /**
   * Advances the closed amount by a measured quantity. `attribution` keeps a
   * bot reduce-only fill distinct from a size that was found flat on the venue
   * without this bot closing it.
   */
  private async addOwnershipClosed(
    paperPositionId: string,
    amount: number,
    attribution: CloseAttribution,
  ): Promise<void> {
    const column =
      attribution === "BOT" ? "bot_closed_amount" : "external_closed_amount";

    await withSerializedDatabaseOperation(() =>
      this.connection.run(
        `UPDATE lighter_owned_positions
         SET closed_amount = LEAST(filled_amount, closed_amount + ?),
             ${column} = LEAST(filled_amount, ${column} + ?),
             status = CASE
               WHEN closed_amount + ? >= filled_amount - ? THEN 'CLOSED'
               ELSE status
             END,
             updated_at = ?
         WHERE paper_position_id = ?`,
        [amount, amount, amount, OWNERSHIP_EPSILON, this.now(), paperPositionId],
      ),
    );
  }

  /** Moves an ownership row between OPEN, UNWIND_PENDING, PENDING and CLOSED. */
  private async markOwnershipStatus(
    paperPositionId: string,
    status: OwnershipStatus,
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

  /**
   * Terminates an ownership row, attributing whatever remainder is still
   * unaccounted to `attribution`. BOT means the venue was confirmed flat after
   * this bot's own close; EXTERNAL means the position disappeared without one.
   */
  private async markOwnershipClosed(
    paperPositionId: string,
    _reason: string,
    attribution: CloseAttribution,
  ): Promise<void> {
    const entry = await this.loadOwnership(paperPositionId);
    if (!entry) return;

    const remaining = Math.max(0, entry.filledAmount - entry.closedAmount);
    if (remaining > OWNERSHIP_EPSILON) {
      await this.addOwnershipClosed(paperPositionId, remaining, attribution);
    }
    await this.markOwnershipStatus(paperPositionId, "CLOSED");
  }

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
    const registry = await this.listOwnership();
    const residual: OwnedVenuePosition[] = [];
    const owned: OwnedVenuePosition[] = [];

    // Shutdown must not leave a fill unowned merely because it was never
    // confirmed. Resolve intents from venue state before flattening.
    const claimedSides = new Set(
      registry
        .filter(
          (row) =>
            (row.status === "OPEN" || row.status === "UNWIND_PENDING") &&
            row.filledAmount - row.closedAmount > OWNERSHIP_EPSILON,
        )
        .map((row) => `${row.symbol}:${row.side}`),
    );

    for (const entry of registry.filter((row) => row.status === "PENDING")) {
      try {
        const alreadyClaimed = claimedSides.has(`${entry.symbol}:${entry.side}`);
        const result = await this.resolvePendingOwnership(
          entry,
          await this.positionsFor(entry.symbol),
          alreadyClaimed,
        );
        if (result.outcome === "ADOPTED" && result.row) {
          claimedSides.add(`${entry.symbol}:${entry.side}`);
          owned.push(result.row);
          this.log(
            `[EXEC] ${action} resolved pending entry ${entry.paperPositionId} ` +
              `on ${entry.symbol}: ${result.row.filledAmount} ${entry.side}`,
          );
          continue;
        }

        if (result.outcome !== "WORKING") continue;

        // An outstanding entry order can fill after the process exits, so it
        // must be cancelled and verified, not ignored.
        const cleared = await this.cancelPendingEntry(entry);
        if (!cleared) {
          residual.push(entry);
          this.log(
            `[EXEC] ERROR ${action} pending entry ${entry.paperPositionId} on ` +
              `${entry.symbol} still has a working order; it could fill after shutdown`,
          );
          continue;
        }

        const after = await this.resolvePendingOwnership(
          entry,
          await this.positionsFor(entry.symbol),
          alreadyClaimed,
        );
        if (after.outcome === "ADOPTED" && after.row) {
          claimedSides.add(`${entry.symbol}:${entry.side}`);
          owned.push(after.row);
          this.log(
            `[EXEC] ${action} pending entry ${entry.paperPositionId} on ` +
              `${entry.symbol} filled before the cancel: ` +
              `${after.row.filledAmount} ${entry.side}`,
          );
        } else if (after.outcome === "WORKING") {
          residual.push(entry);
          this.log(
            `[EXEC] ERROR ${action} pending entry ${entry.paperPositionId} on ` +
              `${entry.symbol} still has a working order after the cancel`,
          );
        } else {
          this.log(
            `[EXEC] ${action} pending entry ${entry.paperPositionId} on ` +
              `${entry.symbol} was cancelled before it filled`,
          );
        }
      } catch (error) {
        residual.push(entry);
        this.log(
          `[EXEC] ERROR ${action} could not resolve pending intent ` +
            `${entry.paperPositionId} on ${entry.symbol}: ` +
            `${this.adapter.redact(error)}`,
        );
      }
    }

    owned.push(
      ...registry.filter(
        (entry) =>
          (entry.status === "OPEN" || entry.status === "UNWIND_PENDING") &&
          entry.filledAmount - entry.closedAmount > OWNERSHIP_EPSILON,
      ),
    );

    for (const entry of owned) {
      let resolved = false;

      for (let attempt = 1; attempt <= SHUTDOWN_FLATTEN_ATTEMPTS; attempt++) {
        // A thrown order, price or position error must not abort the remaining
        // attempts or the other owned positions.
        try {
          const remaining = entry.filledAmount - entry.closedAmount;
          const held = (await this.positionsFor(entry.symbol)).find(
            (position) => position.side === entry.side,
          );

          if (!held || !(remaining > OWNERSHIP_EPSILON)) {
            // No close order was sent by this pass: the size is gone through a
            // manual or external action, not a bot fill.
            await this.markOwnershipClosed(
              entry.paperPositionId,
              action,
              "EXTERNAL",
            );
            resolved = true;
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
            await this.addOwnershipClosed(
              entry.paperPositionId,
              outcome.filled,
              "BOT",
            );
          }

          if (outcome.remaining <= OWNERSHIP_EPSILON) {
            await this.markOwnershipClosed(
              entry.paperPositionId,
              action,
              outcome.alreadyFlat ? "EXTERNAL" : "BOT",
            );
            resolved = true;
            break;
          }

          this.log(
            `[EXEC] ${action} ${entry.symbol} attempt ${attempt}/${SHUTDOWN_FLATTEN_ATTEMPTS} ` +
              `left ${outcome.remaining}; retrying`,
          );
        } catch (error) {
          this.log(
            `[EXEC] ERROR ${action} ${entry.symbol} attempt ` +
              `${attempt}/${SHUTDOWN_FLATTEN_ATTEMPTS} failed: ` +
              `${this.adapter.redact(error)}; retrying`,
          );
        }

        if (attempt < SHUTDOWN_FLATTEN_ATTEMPTS) {
          await this.sleep(DEFAULT_SLEEP_MS);
        }
      }

      if (!resolved) {
        const current = await this
          .loadOwnership(entry.paperPositionId)
          .catch(() => null);
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

      // Entry confirmation and close attribution were added after the first
      // ownership version; the migrations keep existing databases usable.
      for (const column of [
        "confirmation VARCHAR DEFAULT 'CONFIRMED'",
        "bot_closed_amount DOUBLE DEFAULT 0",
        "external_closed_amount DOUBLE DEFAULT 0",
        "legacy_closed_amount DOUBLE DEFAULT 0",
      ]) {
        await this.connection.run(
          `ALTER TABLE lighter_owned_positions ADD COLUMN IF NOT EXISTS ${column}`,
        );
      }

      // Rows written before attribution existed keep their closed size in
      // legacy_closed_amount, so the buckets never contradict closed_amount.
      await this.connection.run(`
        UPDATE lighter_owned_positions
        SET legacy_closed_amount =
          closed_amount - bot_closed_amount - external_closed_amount
        WHERE legacy_closed_amount = 0
          AND closed_amount >
            bot_closed_amount + external_closed_amount + 0.000000001
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
