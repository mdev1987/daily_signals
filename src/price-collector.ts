import {
  PRICE_INTERVALS,
  fetchCandles,
  loadMappedSymbols,
  type MappedSymbol,
  type PriceCandle,
  type PriceInterval,
} from "./biquote";
import { PRICE_REQUEST_CONCURRENCY, PRICE_POLL_INTERVAL_MS } from "./config";
import {
  savePriceCandles,
  type DatabaseConnection,
  type PriceSaveResult,
} from "./database";

export interface PriceCollectionResult {
  symbols: number;
  requests: number;
  succeeded: number;
  failed: number;
  candles: number;
  saved: PriceSaveResult;
  durationMs: number;
}

interface Job {
  mapping: MappedSymbol;
  interval: PriceInterval;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      results[index] = await task(items[index]!);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      () => worker(),
    ),
  );

  return results;
}

/**
 * Fetches every active instrument for every supported interval once, then
 * inserts only the closed candles that are not already stored.
 */
export async function collectPricesOnce(
  connection: DatabaseConnection,
): Promise<PriceCollectionResult> {
  const startedAt = Date.now();
  const mappings = await loadMappedSymbols();

  const jobs: Job[] = mappings.flatMap((mapping) =>
    PRICE_INTERVALS.map((interval) => ({ mapping, interval })),
  );

  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  const candles: PriceCandle[] = [];

  await runWithConcurrency(
    jobs,
    PRICE_REQUEST_CONCURRENCY,
    async ({ mapping, interval }) => {
      try {
        const fetched = await fetchCandles(mapping.symbol, interval);

        candles.push(...fetched);
        succeeded++;
      } catch (error) {
        failed++;

        if (errors.length < 5) {
          errors.push(
            `${mapping.symbol} ${interval}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  );

  const saved = await savePriceCandles(connection, candles);

  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`[PRICE] ${message}`);
    }

    if (failed > errors.length) {
      console.error(`[PRICE] ...and ${failed - errors.length} more failures`);
    }
  }

  return {
    symbols: mappings.length,
    requests: jobs.length,
    succeeded,
    failed,
    candles: candles.length,
    saved,
    durationMs: Date.now() - startedAt,
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer: ReturnType<typeof setTimeout> = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Independent collector loop. It never blocks the signal poll loop and stops
 * promptly when the shared shutdown signal is aborted.
 */
export async function runPriceCollector(
  connection: DatabaseConnection,
  signal: AbortSignal,
): Promise<void> {
  console.log("[PRICE] Collector started.");

  while (!signal.aborted) {
    let elapsedMs = 0;

    try {
      const result = await collectPricesOnce(connection);

      elapsedMs = result.durationMs;

      console.log(
        `[PRICE] ${result.symbols} symbols | ${result.requests} requests | ` +
          `${result.succeeded} ok | ${result.failed} failed | ` +
          `${result.candles} closed candles | ` +
          `${result.saved.inserted} new | ${result.saved.unchanged} existing | ` +
          `${(result.durationMs / 1000).toFixed(1)}s`,
      );
    } catch (error) {
      console.error(
        `[PRICE] Collection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (signal.aborted) break;

    await abortableSleep(
      Math.max(0, PRICE_POLL_INTERVAL_MS - elapsedMs),
      signal,
    );
  }

  console.log("[PRICE] Collector stopped.");
}
