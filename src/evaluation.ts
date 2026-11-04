/**
 * Read-only signal evaluation for the Daily Signals receiver.
 *
 * Implements the experiments used to evaluate the provider's multi-timeframe
 * trend-following strategy before any execution or paper-trading logic exists.
 *
 * Experiments:
 * - E1: main-timeframe signal transition with immediate theoretical entry.
 * - E2: main-timeframe signal transition followed by the documented waiting
 *       period (default 5 minutes), entering at the first available price.
 * - E3: main-timeframe transition followed by price confirmation. Deferred
 *       until a pip threshold is defined by the strategy owner.
 * - E4: exit monitoring driven by the documented lower-timeframe combinations.
 *
 * This module is read-only: it only reads the database and never persists
 * anything. No backtester and no execution logic live here.
 */

import type { DatabaseConnection } from "./database";
import { alignTimeframe, candleIntervalMs, resolveCanonicalSymbol, type AlignedSignal } from "./alignment";
import type { PriceCandle } from "./biquote";

/** Forward return horizons, in number of candles after the entry candle. */
export const FORWARD_RETURN_HORIZONS = [1, 3, 6, 12, 24] as const;

/** Documented waiting period before the theoretical entry (E2). */
export const ENTRY_DELAY_MS = 5 * 60 * 1000;

export interface SignalTransition {
  symbol: string;
  timeframe: string;
  previousSignal: string | null;
  currentSignal: string;
  observedAt: number;
  candleOpenTime: number | null;
  candleCloseTime: number | null;
  candleClose: number | null;
  delayMs: number | null;
  fresh: boolean;
}

export interface ForwardReturnSample {
  symbol: string;
  signal: string;
  entryPrice: number;
  entryTime: number;
}

export interface ForwardReturnHorizonStats {
  n: number;
  meanRet: number;
  median: number;
  min: number;
  max: number;
  hitRate: number;
  mfeMean: number;
  maeMean: number;
}

export interface ForwardReturnStats {
  bySignal: Record<string, { entries: number; horizons: Record<string, ForwardReturnHorizonStats> }>;
}

export interface SignalEvaluationResult {
  timeframe: string;
  totalTransitions: number;
  freshTransitions: number;
  directionalTransitions: number;
  e1: ForwardReturnStats;
  e2: ForwardReturnStats;
}

export interface EvaluationCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? Number.NaN;
  }
  const lower = sorted[mid - 1] ?? Number.NaN;
  const upper = sorted[mid] ?? Number.NaN;
  return (lower + upper) / 2;
}

function isBullish(signal: string): boolean {
  return signal === "BUY" || signal === "STRONG_BUY";
}

function isBearish(signal: string): boolean {
  return signal === "SELL" || signal === "STRONG_SELL";
}

/**
 * Derives signal transitions from aligned snapshots. An entry candidate is a
 * transition (previous signal differs from current signal) that is FRESH at the
 * current observation. The first observation of a symbol is an initialization,
 * not a transition. A transition must be FRESH at the current observation; the
 * previous observation does not need to be fresh.
 */
export function computeTransitions(timeframe: string, aligned: AlignedSignal[]): SignalTransition[] {
  const bySymbol = new Map<string, AlignedSignal[]>();

  for (const row of aligned) {
    const list = bySymbol.get(row.symbol) ?? [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }

  const transitions: SignalTransition[] = [];

  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.observed_at - b.observed_at);

    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1];
      const current = list[i];

      if (previous === undefined || current === undefined) continue;
      if (previous.signal === current.signal) continue;

      const fresh = current.status === "FRESH";

      transitions.push({
        symbol: current.symbol,
        timeframe: current.timeframe,
        previousSignal: previous.signal,
        currentSignal: current.signal,
        observedAt: current.observed_at,
        candleOpenTime: current.candle_open_time,
        candleCloseTime: current.candle_close_time,
        candleClose: current.candle_close,
        delayMs: current.delay_ms,
        fresh,
      });
    }
  }

  return transitions;
}

/** Loads price candles for a timeframe grouped by symbol, sorted by close time. */
export async function loadCandlesBySymbol(
  connection: DatabaseConnection,
  timeframe: string,
): Promise<Map<string, EvaluationCandle[]>> {
  const intervalMs = candleIntervalMs(timeframe);
  const candlesBySymbol = new Map<string, EvaluationCandle[]>();

  if (intervalMs === undefined) {
    return candlesBySymbol;
  }

  const result = await connection.runAndReadAll(
    `SELECT symbol, open_time, open_time + ? AS close_time, open, high, low, close
     FROM price_candles
     WHERE timeframe = ?`,
    [intervalMs, timeframe],
  );

  const rows = (await result.getRowObjects()) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const candle: EvaluationCandle = {
      openTime: Number(row.open_time),
      closeTime: Number(row.close_time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    };

    const list = candlesBySymbol.get(String(row.symbol)) ?? [];
    list.push(candle);
    candlesBySymbol.set(String(row.symbol), list);
  }

  for (const list of candlesBySymbol.values()) {
    list.sort((a, b) => a.closeTime - b.closeTime);
  }

  return candlesBySymbol;
}

/** Computes forward return statistics for a set of entry samples. */
export function computeForwardReturnStats(
  samples: ForwardReturnSample[],
  candlesBySymbol: Map<string, EvaluationCandle[]>,
  horizons: readonly number[],
): ForwardReturnStats {
  const bySignal = new Map<string, ForwardReturnSample[]>();

  for (const sample of samples) {
    const list = bySignal.get(sample.signal) ?? [];
    list.push(sample);
    bySignal.set(sample.signal, list);
  }

  const bySignalOut: ForwardReturnStats["bySignal"] = {};

  for (const [signal, signalSamples] of [...bySignal.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const horizonsOut: Record<string, ForwardReturnHorizonStats> = {};

    for (const horizon of horizons) {
      const rets: number[] = [];
      const mfes: number[] = [];
      const maes: number[] = [];

      for (const sample of signalSamples) {
        const candles = candlesBySymbol.get(sample.symbol) ?? [];
        const future = candles.filter((c) => c.closeTime > sample.entryTime);
        const target = future[horizon - 1];

        if (!target) continue;

        const bearish = isBearish(signal);
        const ret = bearish
          ? (sample.entryPrice - target.close) / sample.entryPrice
          : (target.close - sample.entryPrice) / sample.entryPrice;
        rets.push(ret);

        let mfe = Number.NEGATIVE_INFINITY;
        let mae = Number.NEGATIVE_INFINITY;

        for (let j = 0; j < horizon && j < future.length; j++) {
          const candle = future[j];
          if (candle === undefined) break;
          const favorableUp = (candle.high - sample.entryPrice) / sample.entryPrice;
          const favorableDown = (sample.entryPrice - candle.low) / sample.entryPrice;
          const up = bearish ? favorableDown : favorableUp;
          const down = bearish ? favorableUp : favorableDown;
          if (up > mfe) mfe = up;
          if (down > mae) mae = down;
        }

        mfes.push(mfe);
        maes.push(mae);
      }

      const n = rets.length;

      horizonsOut[String(horizon)] = {
        n,
        meanRet: mean(rets),
        median: median(rets),
        min: rets.length > 0 ? Math.min(...rets) : Number.NaN,
        max: rets.length > 0 ? Math.max(...rets) : Number.NaN,
        hitRate: n > 0 ? rets.filter((r) => r > 0).length / n : Number.NaN,
        mfeMean: mean(mfes),
        maeMean: mean(maes),
      };
    }

    bySignalOut[signal] = { entries: signalSamples.length, horizons: horizonsOut };
  }

  return { bySignal: bySignalOut };
}

/**
 * Runs the signal evaluation for one timeframe and returns the E1/E2 forward
 * return statistics. Read-only: no writes, no persistence.
 */
export async function evaluateTimeframe(
  connection: DatabaseConnection,
  timeframe: string,
): Promise<SignalEvaluationResult> {
  const aligned = await alignTimeframe(connection, timeframe);
  const transitions = computeTransitions(timeframe, aligned);
  const candlesBySymbol = await loadCandlesBySymbol(connection, timeframe);

  // Candles are stored under canonical Biquote instrument names while
  // transitions keep the signal-side symbol, so forward-return lookups have to
  // resolve the canonical instrument as well.
  const candlesByCanonical = new Map<string, EvaluationCandle[]>();
  for (const [symbol, list] of candlesBySymbol.entries()) {
    const canonical = await resolveCanonicalSymbol(symbol);
    const bucket = candlesByCanonical.get(canonical) ?? [];
    for (const candle of list) {
      bucket.push(candle);
    }
    candlesByCanonical.set(canonical, bucket);
  }

  const freshTransitions = transitions.filter((t) => t.fresh);
  const directionalTransitions = freshTransitions.filter(
    (t) => isBullish(t.currentSignal) || isBearish(t.currentSignal),
  );

  const e1Samples: ForwardReturnSample[] = [];
  const e2Samples: ForwardReturnSample[] = [];

  for (const transition of freshTransitions) {
    const signal = transition.currentSignal;

    if (!isBullish(signal) && !isBearish(signal)) continue;

    const canonicalSymbol = await resolveCanonicalSymbol(transition.symbol);

    // E1: immediate theoretical entry at the closing price of the fresh candle.
    e1Samples.push({
      symbol: canonicalSymbol,
      signal,
      entryPrice: transition.candleClose ?? Number.NaN,
      entryTime: transition.candleCloseTime ?? Number.NaN,
    });

    // E2: transition plus the documented waiting period, entering at the first
    // available price after the waiting period ends.
    const waitEnd = transition.observedAt + ENTRY_DELAY_MS;
    const candles = candlesByCanonical.get(canonicalSymbol) ?? [];
    const firstCandleAfterWait = candles.find((c) => c.closeTime > waitEnd);
    const entryPrice = firstCandleAfterWait ? firstCandleAfterWait.close : Number.NaN;

    e2Samples.push({
      symbol: canonicalSymbol,
      signal,
      entryPrice,
      entryTime: waitEnd,
    });
  }

  const e1 = computeForwardReturnStats(e1Samples, candlesByCanonical, FORWARD_RETURN_HORIZONS);
  const e2 = computeForwardReturnStats(e2Samples, candlesByCanonical, FORWARD_RETURN_HORIZONS);

  return {
    timeframe,
    totalTransitions: transitions.length,
    freshTransitions: freshTransitions.length,
    directionalTransitions: directionalTransitions.length,
    e1,
    e2,
  };
}

/**
 * E3: main-timeframe transition followed by price confirmation.
 *
 * Unlike E1 (immediate theoretical entry at the fresh candle close) and E2
 * (entry at the first available candle after the documented waiting period),
 * E3 waits for a price confirmation: after the documented waiting period, the
 * first candle whose close confirms the directional move by at least
 * `pipThresholdPct` (fraction of price) from the transition reference is used
 * as the entry.
 *
 * Read-only: no writes, no persistence. The pip threshold is an input to the
 * experiment and must be defined by the strategy owner before E3 conclusions
 * are drawn.
 */
export async function evaluateE3(
  connection: DatabaseConnection,
  timeframe: string,
  pipThresholdPct: number,
): Promise<{ timeframe: string; pipThresholdPct: number; e3: ForwardReturnStats }> {
  const aligned = await alignTimeframe(connection, timeframe);
  const transitions = computeTransitions(timeframe, aligned).filter(
    (t) => t.fresh && (isBullish(t.currentSignal) || isBearish(t.currentSignal)),
  );

  const candlesBySymbol = await loadCandlesBySymbol(connection, timeframe);
  const candlesByCanonical = new Map<string, EvaluationCandle[]>();
  for (const [symbol, list] of candlesBySymbol.entries()) {
    const canonical = await resolveCanonicalSymbol(symbol);
    const bucket = candlesByCanonical.get(canonical) ?? [];
    for (const candle of list) bucket.push(candle);
    candlesByCanonical.set(canonical, bucket);
  }

  const samples: ForwardReturnSample[] = [];
  for (const transition of transitions) {
    const canonicalSymbol = await resolveCanonicalSymbol(transition.symbol);
    const candles = candlesByCanonical.get(canonicalSymbol) ?? [];
    const reference = transition.candleClose ?? Number.NaN;
    const waitEnd = transition.observedAt + ENTRY_DELAY_MS;
    const entryCandle = candles.find(
      (c) =>
        c.closeTime > waitEnd &&
        !Number.isNaN(reference) &&
        ((isBullish(transition.currentSignal) && c.close >= reference * (1 + pipThresholdPct)) ||
          (isBearish(transition.currentSignal) && c.close <= reference * (1 - pipThresholdPct))),
    );
    if (entryCandle === undefined) continue;
    samples.push({
      symbol: canonicalSymbol,
      signal: transition.currentSignal,
      entryPrice: entryCandle.close,
      entryTime: entryCandle.closeTime,
    });
  }

  const e3 = computeForwardReturnStats(samples, candlesByCanonical, FORWARD_RETURN_HORIZONS);
  return { timeframe, pipThresholdPct, e3 };
}
