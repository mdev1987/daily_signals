import {
  TIMEFRAMES,
  POLL_INTERVAL_MS,
  REQUEST_DELAY_MS,
  PRICE_POLL_INTERVAL_MS,
  PRICE_REQUEST_CONCURRENCY,
  TELEGRAM_ENABLED,
  TOR_ENABLED,
} from "./config";

import { fetchSignalsPage } from "./fetcher";
import { parseSignalsWithDiagnostics } from "./parser";
import {
  DATABASE_PATH,
  openDatabase,
  savePoll,
  getExpectedSignalCount,
} from "./database";
import { runPriceCollector } from "./price-collector";
import { notifyStartup, telegram } from "./telegram";
import { initializePaperTrading, runPaperTradingCycle, logPaperTradingStatus } from "./paper-trading";

const connection = await openDatabase();
const stopCollector = new AbortController();

let running = true;

const POLL_COMPLETENESS_THRESHOLD = 0.95;
const POLL_FAILURE_ALERT_THRESHOLD = 5;

interface PollGuardState {
  consecutiveFailures: number;
  alerted: boolean;
}

const pollGuardState = new Map<string, PollGuardState>();

function rejectPoll(timeframe: string, reason: string): void {
  const state = pollGuardState.get(timeframe) ?? {
    consecutiveFailures: 0,
    alerted: false,
  };

  state.consecutiveFailures++;

  pollGuardState.set(timeframe, state);

  console.warn(
    `[GUARD] ${timeframe}: ${reason} | ` +
      `consecutive failures: ${state.consecutiveFailures}`,
  );

  if (
    state.consecutiveFailures >= POLL_FAILURE_ALERT_THRESHOLD &&
    !state.alerted
  ) {
    state.alerted = true;

    void telegram(
      `# ⚠️ Incomplete Signal Polls\n\n` +
        `**Timeframe:** ${timeframe}\n` +
        `**Consecutive failures:** ${state.consecutiveFailures}\n` +
        `**Reason:** ${reason}\n\n` +
        `Signal data was rejected. The previous database state is preserved.`,
    );
  }
}

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

    const parsed = parseSignalsWithDiagnostics(html, timeframe.name);

    const signals = parsed.signals;

    // Reject empty responses.
    if (signals.length === 0) {
      rejectPoll(timeframe.name, "No valid signals parsed");
      return;
    }

    // Repeated rows are normal in Top 8 / All Pairs.
    // Conflicting values for the same symbol are not.
    if (parsed.conflictingSymbols.length > 0) {
      rejectPoll(
        timeframe.name,
        `Conflicting duplicate symbols: ${parsed.conflictingSymbols.join(", ")}`,
      );
      return;
    }

    // Read expected count from the last successfully saved state.
    const expected = await getExpectedSignalCount(connection, timeframe.name);

    if (expected > 0) {
      const minimum = Math.ceil(expected * POLL_COMPLETENESS_THRESHOLD);

      if (signals.length < minimum) {
        rejectPoll(
          timeframe.name,
          `Incomplete ${signals.length}/${expected} ` + `(minimum ${minimum})`,
        );
        return;
      }
    }

    // Only valid polls reach the database.
    const result = await savePoll(connection, timeframe.name, signals);

    // Paper trading consumes only primary-timeframe transitions. Lower timeframes
    // are retained as monitoring context and never open or close positions.
    await runPaperTradingCycle(connection, result.changes);
    if (result.changes.length > 0) await logPaperTradingStatus(connection);

    // A successful poll resets the consecutive failure counter.
    pollGuardState.delete(timeframe.name);

    for (const item of result.changes) {
      logChange(
        item.symbol,
        item.timeframe,
        item.previousSignal,
        item.currentSignal,
      );
    }

    // Phase 7: signal/price change notifications are not sent. The paper
    // trading engine owns Telegram reporting during the paper session and
    // sends performance reports (balance, open positions, PnL, win rate).

    console.log(
      `[POLL] ${timeframe.name}: ${signals.length}/${expected || signals.length} signals` +
        (result.initialized
          ? " | baseline saved"
          : ` | ${result.changes.length} changes`) +
        (parsed.duplicateSymbols.length > 0
          ? ` | ${parsed.duplicateSymbols.length} repeated rows ignored`
          : ""),
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
    // Abort-aware sleep: a SIGTERM/SIGINT must not wait out the full interval.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), wait);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      stopCollector.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function main(): Promise<void> {
  console.log("==================================");
  console.log(" Live Daily Signals Receiver");
  console.log(`TOR ${TOR_ENABLED ? "enabled" : "disabled"}`);
  console.log(` Signal poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(` Request delay: ${REQUEST_DELAY_MS}ms`);
  console.log(` Timeframes: ${TIMEFRAMES.length}`);
  console.log(` Price poll interval: ${PRICE_POLL_INTERVAL_MS / 1000}s`);
  console.log(` Price concurrency: ${PRICE_REQUEST_CONCURRENCY}`);
  console.log(` Telegram: ${TELEGRAM_ENABLED ? "enabled" : "disabled"}`);
  console.log(" Storage: DuckDB");
  console.log(" Paper trading: Phase 7 (1h/5h/1d entries; 5m/15m/30m monitors)");
  console.log("==================================");

  void notifyStartup({
    signalPollSeconds: POLL_INTERVAL_MS / 1000,
    pricePollSeconds: PRICE_POLL_INTERVAL_MS / 1000,
    timeframes: TIMEFRAMES.length,
    databasePath: DATABASE_PATH,
  });

  await initializePaperTrading(connection);

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

  // Force exit: open handles (Tor client sockets, DuckDB, Telegram) can keep
  // the Bun event loop alive after the async cleanup above completes.
  process.exit(0);
}

await main();
