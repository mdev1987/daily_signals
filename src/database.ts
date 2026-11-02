import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Signal, SignalType } from "./parser";
import type { PriceCandle } from "./biquote";

export const DATABASE_PATH =
  process.env.DATABASE_PATH ?? "./data/signals.duckdb";

export type DatabaseConnection = Awaited<ReturnType<typeof openDatabase>>;

/**
 * DuckDB allows only one transaction per connection. Signal polls and price
 * collection run independently, so every write is serialized through this
 * promise chain to keep the two loops from interfering with each other.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation, operation);

  writeChain = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

export interface SignalChange {
  symbol: string;
  timeframe: string;
  previousSignal?: SignalType;
  currentSignal: SignalType;
}

interface DatabaseSignal {
  symbol: string;
  signal: SignalType;
}

export interface PollResult {
  initialized: boolean;
  changes: SignalChange[];
}

export async function openDatabase() {
  await mkdir(dirname(DATABASE_PATH), { recursive: true });

  const instance = await DuckDBInstance.create(DATABASE_PATH);
  const connection = await instance.connect();

  await connection.run(`
    CREATE TABLE IF NOT EXISTS signals (
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      signal VARCHAR NOT NULL,
      first_seen_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (symbol, timeframe)
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS signal_history (
      event_id VARCHAR PRIMARY KEY,
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      previous_signal VARCHAR,
      current_signal VARCHAR NOT NULL,
      event_type VARCHAR NOT NULL,
      timestamp BIGINT NOT NULL
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS signal_snapshots (
      poll_id VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      signal VARCHAR NOT NULL,
      observed_at BIGINT NOT NULL,
      PRIMARY KEY (poll_id, symbol, timeframe)
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS poll_state (
      timeframe VARCHAR PRIMARY KEY,
      initialized_at BIGINT NOT NULL,
      last_polled_at BIGINT NOT NULL
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS price_candles (
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      open_time BIGINT NOT NULL,
      open DOUBLE NOT NULL,
      high DOUBLE NOT NULL,
      low DOUBLE NOT NULL,
      close DOUBLE NOT NULL,
      volume DOUBLE,
      tick_volume DOUBLE,
      source VARCHAR NOT NULL,
      collected_at BIGINT NOT NULL,
      PRIMARY KEY (symbol, timeframe, open_time)
    )
  `);

  return connection;
}

export function savePoll(
  connection: DatabaseConnection,
  timeframe: string,
  signals: Signal[],
): Promise<PollResult> {
  return serializedWrite(() => savePollUnlocked(connection, timeframe, signals));
}

export function getExpectedSignalCount(
  connection: DatabaseConnection,
  timeframe: string,
): Promise<number> {
  return serializedWrite(async () => {
    const result = await connection.runAndReadAll(
      `SELECT COUNT(*) AS total
       FROM signals
       WHERE timeframe = ?`,
      [timeframe],
    );

    const row = result.getRowObjects()[0] as
      | { total: number | bigint }
      | undefined;

    return Number(row?.total ?? 0);
  });
}

async function savePollUnlocked(
  connection: DatabaseConnection,
  timeframe: string,
  signals: Signal[],
): Promise<PollResult> {
  if (signals.length === 0) {
    throw new Error(`Empty signal batch: ${timeframe}`);
  }

  const now = Date.now();
  const pollId = crypto.randomUUID();

  await connection.run("BEGIN TRANSACTION");

  try {
    const stateResult = await connection.runAndReadAll(
      `SELECT timeframe FROM poll_state WHERE timeframe = ?`,
      [timeframe],
    );

    const initialized = stateResult.getRowObjects().length > 0;

    const currentResult = await connection.runAndReadAll(
      `SELECT symbol, signal
       FROM signals
       WHERE timeframe = ?`,
      [timeframe],
    );

    const currentRows =
      currentResult.getRowObjects() as unknown as DatabaseSignal[];

    const previousSignals = new Map(
      currentRows.map((row) => [row.symbol, row.signal]),
    );

    const changes: SignalChange[] = [];

    if (initialized) {
      for (const item of signals) {
        const previous = previousSignals.get(item.symbol);

        if (previous !== item.signal) {
          changes.push({
            symbol: item.symbol,
            timeframe,
            previousSignal: previous,
            currentSignal: item.signal,
          });
        }
      }
    }

    // Save complete snapshot for this poll.
    const snapshotValues = signals.flatMap((item) => [
      pollId,
      item.symbol,
      timeframe,
      item.signal,
      now,
    ]);

    const snapshotPlaceholders = signals
      .map(() => "(?, ?, ?, ?, ?)")
      .join(", ");

    await connection.run(
      `INSERT INTO signal_snapshots
       (poll_id, symbol, timeframe, signal, observed_at)
       VALUES ${snapshotPlaceholders}`,
      snapshotValues,
    );

    // Update the latest signal state.
    const signalValues = signals.flatMap((item) => [
      item.symbol,
      timeframe,
      item.signal,
      now,
      now,
    ]);

    const signalPlaceholders = signals.map(() => "(?, ?, ?, ?, ?)").join(", ");

    await connection.run(
      `INSERT INTO signals
       (symbol, timeframe, signal, first_seen_at, updated_at)
       VALUES ${signalPlaceholders}
       ON CONFLICT (symbol, timeframe)
       DO UPDATE SET
         signal = EXCLUDED.signal,
         updated_at = EXCLUDED.updated_at`,
      signalValues,
    );

    // Save only actual changes.
    if (changes.length > 0) {
      const historyValues = changes.flatMap((item) => [
        crypto.randomUUID(),
        item.symbol,
        item.timeframe,
        item.previousSignal ?? null,
        item.currentSignal,
        item.previousSignal ? "CHANGE" : "NEW",
        now,
      ]);

      const historyPlaceholders = changes
        .map(() => "(?, ?, ?, ?, ?, ?, ?)")
        .join(", ");

      await connection.run(
        `INSERT INTO signal_history
         (event_id, symbol, timeframe, previous_signal,
          current_signal, event_type, timestamp)
         VALUES ${historyPlaceholders}`,
        historyValues,
      );
    }

    // Mark timeframe as initialized.
    await connection.run(
      `INSERT INTO poll_state
       (timeframe, initialized_at, last_polled_at)
       VALUES (?, ?, ?)
       ON CONFLICT (timeframe)
       DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at`,
      [timeframe, now, now],
    );

    await connection.run("COMMIT");

    return { initialized: !initialized, changes };
  } catch (error) {
    await connection.run("ROLLBACK");
    throw error;
  }
}

export interface PriceSaveResult {
  inserted: number;
  unchanged: number;
}

async function countPriceCandles(
  connection: DatabaseConnection,
): Promise<number> {
  const result = await connection.runAndReadAll(
    "SELECT count(*) AS total FROM price_candles",
  );

  const row = result.getRowObjects()[0] as
    | { total: number | bigint }
    | undefined;

  return Number(row?.total ?? 0);
}

export function savePriceCandles(
  connection: DatabaseConnection,
  candles: PriceCandle[],
): Promise<PriceSaveResult> {
  return serializedWrite(() => savePriceCandlesUnlocked(connection, candles));
}

async function savePriceCandlesUnlocked(
  connection: DatabaseConnection,
  candles: PriceCandle[],
): Promise<PriceSaveResult> {
  const unique = new Map<string, PriceCandle>();

  for (const candle of candles) {
    unique.set(
      `${candle.symbol}\u0000${candle.timeframe}\u0000${candle.openTime}`,
      candle,
    );
  }

  const rows = [...unique.values()];

  if (rows.length === 0) {
    return { inserted: 0, unchanged: 0 };
  }

  await connection.run("BEGIN TRANSACTION");

  try {
    const before = await countPriceCandles(connection);
    const collectedAt = Date.now();
    const chunkSize = 250;

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);

      const values = chunk.flatMap((candle) => [
        candle.symbol,
        candle.timeframe,
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.tickVolume,
        "biquote",
        collectedAt,
      ]);

      const placeholders = chunk
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");

      await connection.run(
        `INSERT INTO price_candles
         (symbol, timeframe, open_time, open, high, low, close,
          volume, tick_volume, source, collected_at)
         VALUES ${placeholders}
         ON CONFLICT (symbol, timeframe, open_time) DO NOTHING`,
        values,
      );
    }

    const after = await countPriceCandles(connection);

    await connection.run("COMMIT");

    const inserted = after - before;

    return {
      inserted,
      unchanged: rows.length - inserted,
    };
  } catch (error) {
    await connection.run("ROLLBACK");
    throw error;
  }
}
