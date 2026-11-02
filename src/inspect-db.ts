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

function printSection(title: string): void {
  console.log("\n========================================");
  console.log(` ${title}`);
  console.log("========================================");
}

function normalizeRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint" ? Number(value) : value,
      ]),
    ),
  );
}

function formatTimestamp(value: unknown): string {
  if (value === null || value === undefined) return "-";

  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) return String(value);

  return new Date(timestamp).toISOString();
}

function formatRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key === "timestamp" ||
        key === "observed_at" ||
        key === "updated_at" ||
        key === "first_seen_at" ||
        key === "initialized_at" ||
        key === "last_polled_at"
          ? formatTimestamp(value)
          : typeof value === "bigint"
            ? Number(value)
            : value,
      ]),
    ),
  );
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? "EUR/USD";

  const instance = await DuckDBInstance.create(DATABASE_PATH);
  const connection = await instance.connect();

  try {
    console.log("========================================");
    console.log("       LIVE DAILY SIGNALS DATABASE");
    console.log("========================================");

    // 1. Snapshot counts
    printSection("SNAPSHOT COUNTS");

    const snapshots = await connection.runAndReadAll(`
      SELECT
        timeframe,
        COUNT(*) AS total,
        COUNT(DISTINCT poll_id) AS polls,
        COUNT(DISTINCT symbol) AS symbols
      FROM signal_snapshots
      GROUP BY timeframe
      ORDER BY ${TIMEFRAME_ORDER}
    `);

    console.table(normalizeRows(snapshots.getRowObjects()));

    // 2. Signal history counts
    printSection("SIGNAL HISTORY COUNTS");

    const history = await connection.runAndReadAll(`
      SELECT
        timeframe,
        event_type,
        COUNT(*) AS total
      FROM signal_history
      GROUP BY timeframe, event_type
      ORDER BY ${TIMEFRAME_ORDER}, event_type
    `);

    console.table(normalizeRows(history.getRowObjects()));

    // 3. Changes grouped by polling cycle
    printSection("CHANGES PER POLL");

    const changesPerPoll = await connection.runAndReadAll(`
      SELECT
        timeframe,
        timestamp,
        COUNT(*) AS changes
      FROM signal_history
      GROUP BY timeframe, timestamp
      ORDER BY timestamp DESC, ${TIMEFRAME_ORDER}
      LIMIT 50
    `);

    console.table(formatRows(changesPerPoll.getRowObjects()));

    // 4. Snapshot counts per poll
    printSection("SNAPSHOTS PER POLL");

    const snapshotsPerPoll = await connection.runAndReadAll(`
      SELECT
        timeframe,
        observed_at,
        COUNT(*) AS total
      FROM signal_snapshots
      GROUP BY timeframe, observed_at
      ORDER BY observed_at DESC, ${TIMEFRAME_ORDER}
      LIMIT 50
    `);

    console.table(formatRows(snapshotsPerPoll.getRowObjects()));

    // 5. Latest signal history
    printSection("LATEST SIGNAL HISTORY");

    const recentHistory = await connection.runAndReadAll(`
      SELECT
        symbol,
        timeframe,
        previous_signal,
        current_signal,
        event_type,
        timestamp
      FROM signal_history
      ORDER BY timestamp DESC
      LIMIT 30
    `);

    console.table(formatRows(recentHistory.getRowObjects()));

    // 6. History for a specific symbol
    printSection(`HISTORY FOR ${symbol}`);

    const symbolHistory = await connection.runAndReadAll(
      `
        SELECT
          timeframe,
          previous_signal,
          current_signal,
          event_type,
          timestamp
        FROM signal_history
        WHERE symbol = ?
        ORDER BY timestamp ASC
      `,
      [symbol],
    );

    const symbolRows = formatRows(symbolHistory.getRowObjects());

    if (symbolRows.length === 0) {
      console.log(`No history found for ${symbol}`);
    } else {
      console.table(symbolRows);
    }

    // 7. Current signals summary
    printSection("CURRENT SIGNALS");

    const currentSignals = await connection.runAndReadAll(`
      SELECT
        timeframe,
        COUNT(*) AS total_signals,
        COUNT(DISTINCT signal) AS different_signal_types
      FROM signals
      GROUP BY timeframe
      ORDER BY ${TIMEFRAME_ORDER}
    `);

    console.table(normalizeRows(currentSignals.getRowObjects()));

    // 8. Signal distribution
    printSection("CURRENT SIGNAL DISTRIBUTION");

    const distribution = await connection.runAndReadAll(`
      SELECT
        timeframe,
        signal,
        COUNT(*) AS total
      FROM signals
      GROUP BY timeframe, signal
      ORDER BY ${TIMEFRAME_ORDER}, signal
    `);

    console.table(normalizeRows(distribution.getRowObjects()));

    // 9. Database summary
    printSection("DATABASE SUMMARY");

    const summary = await connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM signals) AS current_signals,
        (SELECT COUNT(*) FROM signal_history) AS history_events,
        (SELECT COUNT(*) FROM signal_snapshots) AS snapshots,
        (SELECT COUNT(DISTINCT poll_id) FROM signal_snapshots) AS total_polls
    `);

    console.table(normalizeRows(summary.getRowObjects()));

    console.log("\n[DB] Inspection completed successfully.");
  } catch (error) {
    console.error("\n[DB INSPECT ERROR]", error);
    process.exitCode = 1;
  } finally {
    connection.disconnectSync();
  }
}

await main();
