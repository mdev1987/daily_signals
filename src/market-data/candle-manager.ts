import type { Candle } from "../exchanges/exchange.types";

export interface CandleIngestResult {
  /** True when the candle belongs to a newer interval than the current one. */
  isNewInterval: boolean;
  /** True when this call is the first time this finalized candle is seen. */
  shouldEvaluate: boolean;
  /** True when the candle is still forming. */
  isInProgress: boolean;
}

function keyOf(symbol: string, timeframe: string): string {
  return `${symbol}\u0000${timeframe}`;
}

/**
 * Guarantees that a completed candle triggers strategy evaluation exactly
 * once, even if the exchange resends it or the process receives overlapping
 * WebSocket updates.
 *
 * Historical backtests must use the same rule: a decision is evaluated on
 * candle close, never on an in-progress candle.
 */
export class CandleManager {
  private readonly lastOpenTime = new Map<string, number>();
  private readonly lastEvaluated = new Map<string, number>();

  ingest(candle: Candle): CandleIngestResult {
    const key = keyOf(candle.symbol, candle.timeframe);
    const previousOpenTime = this.lastOpenTime.get(key) ?? null;
    const evaluatedOpenTime = this.lastEvaluated.get(key) ?? null;

    const isNewInterval =
      previousOpenTime === null || candle.openTime > previousOpenTime;

    if (isNewInterval) {
      this.lastOpenTime.set(key, candle.openTime);
    }

    if (!candle.isFinal) {
      return { isNewInterval, shouldEvaluate: false, isInProgress: true };
    }

    const shouldEvaluate =
      evaluatedOpenTime === null || candle.openTime > evaluatedOpenTime;

    if (shouldEvaluate) {
      this.lastEvaluated.set(key, candle.openTime);
    }

    return {
      isNewInterval,
      shouldEvaluate,
      isInProgress: false,
    };
  }

  /** Last finalized candle that triggered (or would trigger) evaluation. */
  getLastEvaluatedOpenTime(
    symbol: string,
    timeframe: string,
  ): number | null {
    return this.lastEvaluated.get(keyOf(symbol, timeframe)) ?? null;
  }

  /** Restores state after a restart so a replay cannot double-evaluate. */
  restoreLastEvaluatedOpenTime(
    symbol: string,
    timeframe: string,
    openTime: number,
  ): void {
    this.lastEvaluated.set(keyOf(symbol, timeframe), openTime);
  }
}

/**
 * Aligns a timestamp to the timeframe grid. Used when requesting a backfill
 * so pagination starts on a real candle boundary.
 */
export function alignToTimeframe(timestamp: number, timeframeMs: number): number {
  return Math.floor(timestamp / timeframeMs) * timeframeMs;
}

/**
 * The last candle that can be considered final at `now`. A candle opening at
 * this timestamp has closed by `now`.
 */
export function lastClosedCandleOpenTime(
  now: number,
  timeframeMs: number,
): number {
  return alignToTimeframe(now, timeframeMs) - timeframeMs;
}
