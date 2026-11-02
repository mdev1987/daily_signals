import {
  TIMEFRAMES,
  POLL_INTERVAL_MS,
  REQUEST_DELAY_MS,
  PRICE_POLL_INTERVAL_MS,
  PRICE_REQUEST_CONCURRENCY,
  TELEGRAM_ENABLED,
} from "./config";

import { fetchSignalsPage } from "./fetcher";
import { parseSignals } from "./parser";
import { DATABASE_PATH, openDatabase, savePoll } from "./database";
import { runPriceCollector } from "./price-collector";
import { notifySignalChanges, notifyStartup } from "./telegram";

const connection = await openDatabase();
const stopCollector = new AbortController();

let running = true;

process.on("SIGINT", () => {
  console.log("\n[ENGINE] Stopping...");
  running = false;
  stopCollector.abort();
});

process.on("SIGTERM", () => {
  console.log("\n[ENGINE] Stopping...");
  running = false;
  stopCollector.abort();
});

function logChange(
  symbol: string,
  timeframe: string,
  previous: string | undefined,
  current: string,
): void {
  const time = new Date().toLocaleTimeString();

  if (!previous) {
    console.log(`\n[${time}] [NEW] ${symbol} | ${timeframe} | ${current}`);
    return;
  }

  console.log(
    `\n[${time}] [CHANGE] ${symbol} | ${timeframe} | ${previous} -> ${current}`,
  );
}

async function pollTimeframe(
  timeframe: (typeof TIMEFRAMES)[number],
): Promise<void> {
  try {
    const html = await fetchSignalsPage(timeframe.time);
    const signals = parseSignals(html, timeframe.name);

    if (signals.length === 0) {
      throw new Error("No signals parsed. Database was not updated.");
    }

    const result = await savePoll(connection, timeframe.name, signals);

    for (const item of result.changes) {
      logChange(
        item.symbol,
        item.timeframe,
        item.previousSignal,
        item.currentSignal,
      );
    }

    if (result.changes.length > 0) {
      // Notifications must never delay or break the signal polling cycle.
      void notifySignalChanges(result.changes);
    }

    console.log(
      `[POLL] ${timeframe.name}: ${signals.length} signals` +
        (result.initialized
          ? " | baseline saved"
          : ` | ${result.changes.length} changes`),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[ERROR] ${timeframe.name}: ${message}`);
  }
}

async function runCycle(): Promise<void> {
  const cycleStarted = Date.now();

  console.log(`\n[CYCLE] ${new Date().toLocaleTimeString()}`);

  for (const [index, timeframe] of TIMEFRAMES.entries()) {
    if (!running) break;

    await pollTimeframe(timeframe);

    if (running && index < TIMEFRAMES.length - 1) {
      await Bun.sleep(REQUEST_DELAY_MS);
    }
  }

  const elapsed = Date.now() - cycleStarted;
  const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);

  console.log(`\n[NEXT] Next cycle in ${(wait / 1000).toFixed(1)} seconds`);

  if (running) {
    await Bun.sleep(wait);
  }
}

async function main(): Promise<void> {
  console.log("==================================");
  console.log(" Live Daily Signals Receiver");
  console.log(` Signal poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(` Request delay: ${REQUEST_DELAY_MS}ms`);
  console.log(` Timeframes: ${TIMEFRAMES.length}`);
  console.log(` Price poll interval: ${PRICE_POLL_INTERVAL_MS / 1000}s`);
  console.log(` Price concurrency: ${PRICE_REQUEST_CONCURRENCY}`);
  console.log(` Telegram: ${TELEGRAM_ENABLED ? "enabled" : "disabled"}`);
  console.log(" Storage: DuckDB");
  console.log("==================================");

  void notifyStartup({
    signalPollSeconds: POLL_INTERVAL_MS / 1000,
    pricePollSeconds: PRICE_POLL_INTERVAL_MS / 1000,
    timeframes: TIMEFRAMES.length,
    databasePath: DATABASE_PATH,
  });

  // Runs independently from the signal cycle and writes through the same
  // serialized database queue.
  const priceTask = runPriceCollector(connection, stopCollector.signal);

  try {
    while (running) {
      await runCycle();
    }
  } finally {
    stopCollector.abort();
    await priceTask;
    connection.disconnectSync();
    console.log("[ENGINE] Database connection closed.");
  }

  console.log("[ENGINE] Stopped.");
}

await main();
