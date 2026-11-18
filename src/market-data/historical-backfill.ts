import type { Candle, ExchangeAdapter } from "../exchanges/exchange.types";
import {
  beginIngestionRun,
  finishIngestionRun,
  getFirstCandleOpenTime,
  getLastCandleOpenTime,
  insertCandles,
  loadCandles,
  setCursor,
} from "../storage/repositories/candle.repository";
import { validateCandles } from "./data-validator";
import {
  alignToTimeframe,
  lastClosedCandleOpenTime,
} from "./candle-manager";
import { timeframeToMs } from "./timeframes";
import type { ResearchConnection } from "../storage/database";

const MAX_PAGE_SIZE = 200;

export interface BackfillOptions {
  symbol: string;
  timeframe: string;
  /** Earliest candle open time to keep, in epoch milliseconds. */
  from: number;
  /** Upper bound; defaults to now. Only finalized candles are stored. */
  to?: number;
  /** Candles per request, clamped to the exchange maximum of 200. */
  pageLimit?: number;
  /**
   * Skip a symbol whose stored range already covers the request. Defaults to
   * true; missing or partial ranges are always re-walked idempotently.
   */
  resume?: boolean;
  /** Delay between page requests, in milliseconds. Defaults to 250. */
  requestDelayMs?: number;
  exchange?: string;
}

export type BackfillStopReason =
  | "complete"
  | "empty-page"
  | "short-page"
  | "no-range";

export interface BackfillResult {
  exchange: string;
  symbol: string;
  timeframe: string;
  requestedFrom: number;
  requestedTo: number;
  startedAt: number;
  finishedAt: number | null;
  pages: number;
  requests: number;
  received: number;
  inserted: number;
  updated: number;
  /** Oldest candle already stored before this run, when resuming. */
  resumedFrom: number | null;
  stopReason: BackfillStopReason;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FETCH_ATTEMPTS = 3;

async function fetchPage(
  adapter: ExchangeAdapter,
  symbol: string,
  timeframe: string,
  since: number,
  limit: number,
  until: number,
): Promise<Candle[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      return await adapter.getOHLCV(symbol, timeframe, since, limit, until);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS - 1) {
        // Transient network and rate-limit failures are retried with
        // exponential backoff. The operation is read-only, so retrying is safe.
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

/**
 * Resumable, idempotent OHLCV backfill for one symbol/timeframe.
 *
 * ApeX's kline endpoint returns the most recent `limit` candles ending at
 * `end`; `start` only clamps the lower edge. Pagination therefore walks
 * backwards from the newest closed candle. The still-forming interval is never
 * stored, so research code cannot read an incomplete candle.
 */
export async function backfillCandles(
  adapter: ExchangeAdapter,
  connection: ResearchConnection,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const exchange = options.exchange ?? adapter.id;
  const timeframeMs = timeframeToMs(options.timeframe);
  const pageLimit = Math.max(
    1,
    Math.min(Math.trunc(options.pageLimit ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE),
  );
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? 250);
  const startedAt = Date.now();

  const to = options.to ?? startedAt;
  const upperBound = lastClosedCandleOpenTime(to, timeframeMs);
  const fromAligned = alignToTimeframe(options.from, timeframeMs);
  const resume = options.resume ?? true;

  const existingFirst = await getFirstCandleOpenTime(
    connection,
    exchange,
    options.symbol,
    options.timeframe,
  );
  const existingLast = await getLastCandleOpenTime(
    connection,
    exchange,
    options.symbol,
    options.timeframe,
  );

  const result: BackfillResult = {
    exchange,
    symbol: options.symbol,
    timeframe: options.timeframe,
    requestedFrom: options.from,
    requestedTo: to,
    startedAt,
    finishedAt: null,
    pages: 0,
    requests: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    resumedFrom: resume ? existingFirst : null,
    stopReason: "no-range",
    durationMs: 0,
  };

  const finish = () => {
    result.finishedAt = Date.now();
    result.durationMs = result.finishedAt - startedAt;
    return result;
  };

  if (upperBound < fromAligned) return finish();

  const alreadyCovered =
    resume &&
    existingFirst !== null &&
    existingLast !== null &&
    existingFirst <= fromAligned &&
    existingLast >= upperBound;

  if (alreadyCovered) return finish();

  const runId = await beginIngestionRun(
    connection,
    exchange,
    options.symbol,
    options.timeframe,
    fromAligned,
    upperBound,
  );

  // Exclusive end of the requested window.
  let endExclusive = upperBound + timeframeMs;

  try {
    while (endExclusive - timeframeMs >= fromAligned) {
      const page = await fetchPage(
        adapter,
        options.symbol,
        options.timeframe,
        fromAligned,
        pageLimit,
        endExclusive,
      );
      result.requests++;
      result.pages++;

      const usable = page.filter(
        (candle) =>
          candle.openTime >= fromAligned &&
          candle.openTime < endExclusive &&
          candle.isFinal,
      );

      result.received += usable.length;

      if (usable.length > 0) {
        const saved = await insertCandles(connection, exchange, usable);
        result.inserted += saved.inserted;
        result.updated += saved.updated;
      }

      if (page.length === 0) {
        result.stopReason = "empty-page";
        break;
      }

      const firstOpenTime = page[0]!.openTime;

      if (firstOpenTime >= endExclusive) {
        // Defensive guard: the exchange did not honour the `until` bound.
        result.stopReason = "short-page";
        break;
      }

      await setCursor(
        connection,
        exchange,
        options.symbol,
        options.timeframe,
        firstOpenTime,
      );

      endExclusive = firstOpenTime;

      if (endExclusive <= fromAligned) {
        result.stopReason = "complete";
        break;
      }

      if (page.length < pageLimit) {
        result.stopReason = "short-page";
        break;
      }

      if (requestDelayMs > 0) await sleep(requestDelayMs);
    }

    const finished = finish();

    await finishIngestionRun(connection, runId, {
      status: "completed",
      received: result.received,
      inserted: result.inserted,
    });

    return finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await finishIngestionRun(connection, runId, {
      status: "failed",
      received: result.received,
      inserted: result.inserted,
      error: message,
    });

    throw error;
  }
}

export interface BackfillUniverseOptions
  extends Omit<BackfillOptions, "symbol"> {
  symbols: string[];
}

/**
 * Runs the backfill sequentially so the exchange rate limit is respected.
 * One failing symbol does not abort the rest of the universe.
 */
export async function backfillUniverse(
  adapter: ExchangeAdapter,
  connection: ResearchConnection,
  options: BackfillUniverseOptions,
): Promise<{ results: BackfillResult[]; failures: string[] }> {
  const results: BackfillResult[] = [];
  const failures: string[] = [];

  for (const symbol of options.symbols) {
    try {
      results.push(
        await backfillCandles(adapter, connection, { ...options, symbol }),
      );
    } catch (error) {
      failures.push(
        `${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { results, failures };
}

export interface StoredValidationSummary {
  symbol: string;
  timeframe: string;
  candles: number;
  passed: boolean;
  invalid: number;
  duplicates: number;
  missingIntervals: number;
  nonFinalCandles: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
}

export async function validateStoredSeries(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
): Promise<StoredValidationSummary> {
  const candles = await loadCandles(
    connection,
    exchange,
    symbol,
    timeframe,
  );
  const report = validateCandles(candles, timeframeToMs(timeframe));

  return {
    symbol,
    timeframe,
    candles: report.total,
    passed: report.passed,
    invalid: report.invalid,
    duplicates: report.duplicates,
    missingIntervals: report.missingIntervals,
    nonFinalCandles: report.nonFinalCandles,
    firstOpenTime: report.firstOpenTime,
    lastOpenTime: report.lastOpenTime,
  };
}
