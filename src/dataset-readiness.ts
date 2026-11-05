/**
 * Dataset Readiness Report — read-only coverage and sample-adequacy audit.
 *
 * Measures data coverage and sample-adequacy indicators without evaluating or
 * optimizing strategy performance. Intended for Phase 6 preparation: informs
 * whether additional data collection is needed before a new independent
 * out-of-sample run.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";

const DATABASE_PATH = "./data/signals.duckdb";

const TIMEFRAME_ORDER = `
  CASE timeframe
    WHEN '5m' THEN 1
    WHEN '15m' THEN 2
    WHEN '30m' THEN 3
    WHEN '1h' THEN 4
    WHEN '4h' THEN 5
    WHEN '5h' THEN 6
    WHEN '1d' THEN 7
    WHEN '1w' THEN 8
    ELSE 9
  END
`;

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function formatTimestamp(value: unknown): string {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts)) return "-";
  return new Date(ts).toISOString();
}

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(DATABASE_PATH);
  const connection = await instance.connect();

  const fingerprint = await sha256File(DATABASE_PATH);

  const signals = await connection.runAndReadAll(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT symbol) AS symbols,
      MIN(first_seen_at) AS min_ts,
      MAX(first_seen_at) AS max_ts
    FROM signals
  `);
  const signalsRow = signals.getRowObjects()[0] as Record<string, unknown>;
  const signalsSummary = {
    total: toNumber(signalsRow.total),
    symbols: toNumber(signalsRow.symbols),
    minTs: toNumber(signalsRow.min_ts),
    maxTs: formatTimestamp(signalsRow.max_ts),
  };

  const history = await connection.runAndReadAll(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT symbol) AS symbols,
      MIN(timestamp) AS min_ts,
      MAX(timestamp) AS max_ts
    FROM signal_history
  `);
  const historyRow = history.getRowObjects()[0] as Record<string, unknown>;
  const historySummary = {
    total: toNumber(historyRow.total),
    symbols: toNumber(historyRow.symbols),
    minTs: toNumber(historyRow.min_ts),
    maxTs: formatTimestamp(historyRow.max_ts),
  };

  const snapshots = await connection.runAndReadAll(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT symbol) AS symbols,
      MIN(observed_at) AS min_ts,
      MAX(observed_at) AS max_ts
    FROM signal_snapshots
  `);
  const snapshotsRow = snapshots.getRowObjects()[0] as Record<string, unknown>;
  const snapshotsSummary = {
    total: toNumber(snapshotsRow.total),
    symbols: toNumber(snapshotsRow.symbols),
    minTs: toNumber(snapshotsRow.min_ts),
    maxTs: formatTimestamp(snapshotsRow.max_ts),
  };

  const candleCoverage = await connection.runAndReadAll(`
    SELECT
      timeframe,
      COUNT(DISTINCT symbol) AS symbols_with_candles,
      COUNT(*) AS candles,
      MIN(open_time) AS min_open,
      MAX(open_time) AS max_open
    FROM price_candles
    GROUP BY timeframe
    ORDER BY ${TIMEFRAME_ORDER}
  `);
  const candleRows = candleCoverage.getRowObjects() as Array<Record<string, unknown>>;

  const signalCoverage = await connection.runAndReadAll(`
    SELECT
      timeframe,
      COUNT(DISTINCT symbol) AS symbols_with_signals,
      COUNT(*) AS signals
    FROM signals
    GROUP BY timeframe
    ORDER BY ${TIMEFRAME_ORDER}
  `);
  const signalRows = signalCoverage.getRowObjects() as Array<Record<string, unknown>>;

  console.log("========================================");
  console.log("       DATASET READINESS REPORT (read-only)");
  console.log("========================================");
  console.log(`dataset=${DATABASE_PATH}`);
  console.log(`sha256=${fingerprint}`);
  console.log(`signals=${JSON.stringify(signalsSummary)}`);
  console.log(`signal_history=${JSON.stringify(historySummary)}`);
  console.log(`signal_snapshots=${JSON.stringify(snapshotsSummary)}`);
  console.log("");
  console.log("---- candle coverage per timeframe ----");
  for (const row of candleRows) {
    console.log(
      `tf=${String(row.timeframe)} symbols=${toNumber(row.symbols_with_candles)} candles=${toNumber(row.candles)} minOpen=${toNumber(row.min_open)} maxOpen=${toNumber(row.max_open)}`,
    );
  }
  console.log("---- signal coverage per timeframe ----");
  for (const row of signalRows) {
    console.log(
      `tf=${String(row.timeframe)} symbols=${toNumber(row.symbols_with_signals)} signals=${toNumber(row.signals)}`,
    );
  }

  connection.disconnectSync();
}

void main();
