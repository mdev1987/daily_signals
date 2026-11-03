/**
 * Read-only signal → price alignment for the Daily Signals receiver.
 *
 * A signal snapshot is aligned to the market candle that was already closed
 * at the moment the signal was observed (`close_time <= observed_at`). The
 * latest such candle is selected, which guarantees no look-ahead bias. A
 * candle is only usable when its close happened within the candle interval of
 * the signal timeframe; larger delays mark the pair STALE.
 *
 * Snapshots are stored under the signal-side symbol name while candles are
 * stored under the canonical Biquote instrument, so every snapshot is first
 * resolved to its canonical instrument before the candle lookup happens.
 */

import { loadMappedSymbols } from "./biquote";
import type { DatabaseConnection } from "./database";

export type AlignmentStatus = "FRESH" | "STALE" | "UNMATCHED" | "UNSUPPORTED";

export interface AlignedSignal {
  symbol: string;
  timeframe: string;
  signal: string;
  observed_at: number;
  candle_open_time: number | null;
  candle_close_time: number | null;
  candle_close: number | null;
  delay_ms: number | null;
  status: AlignmentStatus;
}

/** Candle interval per signal timeframe, in milliseconds. */
const CANDLE_INTERVAL_MS: Record<string, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "5h": 18_000_000,
  "1w": 604_800_000,
};

let mappedSymbolsCache: Awaited<ReturnType<typeof loadMappedSymbols>> | null = null;

/**
 * Resolves a signal symbol to its canonical Biquote instrument. Signal
 * snapshots use human-friendly names (`Alphabet A`) while collected candles
 * are stored under the canonical instrument (`GOOGL`), so alignment has to
 * compare canonical identities. Unknown symbols map to themselves.
 */
export async function resolveCanonicalSymbol(symbol: string): Promise<string> {
  if (!mappedSymbolsCache) {
    mappedSymbolsCache = await loadMappedSymbols();
  }

  const key = symbol.toUpperCase();
  const mapping = mappedSymbolsCache.find(
    (entry) => entry.original.toUpperCase() === key,
  );

  return mapping ? mapping.symbol : symbol;
}

export function candleIntervalMs(timeframe: string): number | undefined {
  return CANDLE_INTERVAL_MS[timeframe];
}

/**
 * Aligns every signal snapshot of a timeframe with the candle that was
 * closed at or before the observation. The result is read-only: nothing is
 * persisted and the database is only queried.
 */
export async function alignTimeframe(
  connection: DatabaseConnection,
  timeframe: string,
): Promise<AlignedSignal[]> {
  const intervalMs = CANDLE_INTERVAL_MS[timeframe];

  if (intervalMs === undefined) {
    return [];
  }

  const candleResult = await connection.runAndReadAll(
    `SELECT
      symbol,
      timeframe,
      open_time,
      open_time + ? AS close_time,
      close AS candle_close
    FROM price_candles
    WHERE timeframe = ?`,
    [intervalMs, timeframe],
  );

  const candleRows = (await candleResult.getRowObjects()) as Array<
    Record<string, unknown>
  >;

  const candlesBySymbol = new Map<
    string,
    Array<{ open_time: number; close_time: number; candle_close: number }>
  >();

  for (const row of candleRows) {
    const symbol = String(row.symbol);
    const openTime = Number(row.open_time);
    const closeTime = Number(row.close_time);
    const candleClose = Number(row.candle_close);

    const list = candlesBySymbol.get(symbol) ?? [];

    list.push({ open_time: openTime, close_time: closeTime, candle_close: candleClose });
    candlesBySymbol.set(symbol, list);
  }

  const snapshotResult = await connection.runAndReadAll(
    `SELECT
      poll_id,
      symbol,
      timeframe,
      signal,
      observed_at
    FROM signal_snapshots
    WHERE timeframe = ?`,
    [timeframe],
  );

  const snapshotRows = (await snapshotResult.getRowObjects()) as Array<
    Record<string, unknown>
  >;

  const aligned: AlignedSignal[] = [];

  for (const row of snapshotRows) {
    const symbol = String(row.symbol);
    const signal = String(row.signal);
    const observedAt = Number(row.observed_at);
    const canonicalSymbol = await resolveCanonicalSymbol(symbol);

    const candles = candlesBySymbol.get(canonicalSymbol) ?? [];

    let best: { open_time: number; close_time: number; candle_close: number } | null =
      null;

    for (const candle of candles) {
      if (candle.close_time <= observedAt) {
        if (!best || candle.close_time > best.close_time) {
          best = candle;
        }
      }
    }

    let status: AlignmentStatus;
    let candleOpenTime: number | null = null;
    let candleCloseTime: number | null = null;
    let candleClose: number | null = null;
    let delayMs: number | null = null;

    if (candleRows.length === 0) {
      // No market data collected for this timeframe yet.
      status = "UNSUPPORTED";
    } else if (best === null) {
      status = "UNMATCHED";
    } else {
      candleOpenTime = best.open_time;
      candleCloseTime = best.close_time;
      candleClose = best.candle_close;
      delayMs = observedAt - best.close_time;
      status = delayMs <= intervalMs ? "FRESH" : "STALE";
    }

    aligned.push({
      symbol,
      timeframe,
      signal,
      observed_at: observedAt,
      candle_open_time: candleOpenTime,
      candle_close_time: candleCloseTime,
      candle_close: candleClose,
      delay_ms: delayMs,
      status,
    });
  }

  return aligned;
}
