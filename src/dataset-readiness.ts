/**
 * Dataset Readiness Report — read-only coverage and sample-adequacy audit.
 *
 * Measures data coverage and sample-adequacy indicators without evaluating or
 * optimizing strategy performance. Intended for Phase 6 preparation: informs
 * whether additional data collection is needed before a new independent
 * out-of-sample run.
 *
 * Checks performed:
 * - Dataset fingerprint and basic table counts
 * - Candle coverage per timeframe
 * - Signal coverage per timeframe
 * - Signal-to-candle join coverage (signals with usable price data)
 * - Per-symbol event distribution (concentration indicators)
 * - Temporal continuity (max candle gap per symbol/timeframe)
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

  // Signal-to-candle join coverage: (timeframe, symbol) pairs that have both
  // at least one signal and at least one usable candle.
  const joinCoverage = await connection.runAndReadAll(`
    SELECT
      s.timeframe AS timeframe,
      s.symbol AS symbol,
      COUNT(*) AS n_signals,
      COUNT(c.close) AS n_candles
    FROM signals s
    LEFT JOIN price_candles c
      ON c.symbol = s.symbol AND c.timeframe = s.timeframe
    GROUP BY s.timeframe, s.symbol
    ORDER BY s.timeframe, s.symbol
  `);
  const joinRows = joinCoverage.getRowObjects() as Array<Record<string, unknown>>;

  // Per-symbol event distribution from raw signal history.
  const symbolEventDistribution = await connection.runAndReadAll(`
    SELECT
      symbol,
      timeframe,
      COUNT(*) AS events
    FROM signal_history
    GROUP BY symbol, timeframe
    ORDER BY events DESC
  `);
  const symbolEventRows = symbolEventDistribution.getRowObjects() as Array<Record<string, unknown>>;

  // Temporal continuity: max gap (ms) between consecutive candles per (symbol, timeframe).
  const temporalGaps = await connection.runAndReadAll(`
    SELECT
      timeframe,
      symbol,
      COUNT(*) AS n_candles,
      MAX(CASE WHEN next_open IS NULL THEN 0 ELSE next_open - open_time END) AS max_gap_ms
    FROM (
      SELECT
        symbol,
        timeframe,
        open_time,
        LEAD(open_time) OVER (PARTITION BY symbol, timeframe ORDER BY open_time) AS next_open
      FROM price_candles
    ) g
    GROUP BY timeframe, symbol
    ORDER BY timeframe, symbol
  `);
  const gapRows = temporalGaps.getRowObjects() as Array<Record<string, unknown>>;

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
  console.log("---- signal-to-candle join coverage (timeframe, symbol -> n_signals, n_candles) ----");
  for (const row of joinRows) {
    console.log(
      `tf=${String(row.timeframe)} symbol=${String(row.symbol)} n_signals=${toNumber(row.n_signals)} n_candles=${toNumber(row.n_candles)}`,
    );
  }
  console.log("---- per-symbol event distribution (top by events) ----");
  for (const row of symbolEventRows.slice(0, 20)) {
    console.log(
      `symbol=${String(row.symbol)} tf=${String(row.timeframe)} events=${toNumber(row.events)}`,
    );
  }
  console.log("---- temporal continuity (max gap ms per timeframe, symbol) ----");
  for (const row of gapRows) {
    console.log(
      `tf=${String(row.timeframe)} symbol=${String(row.symbol)} n_candles=${toNumber(row.n_candles)} max_gap_ms=${toNumber(row.max_gap_ms)}`,
    );
  }

  connection.disconnectSync();
}

void main();
