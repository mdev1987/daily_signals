import type { Candle } from "../../exchanges/exchange.types";
import type { DuckDBValue } from "@duckdb/node-api";
import { toNumber, type ResearchConnection } from "../database";

const CANDLE_CHUNK_SIZE = 500;

const CANDLE_COLUMNS = [
  "exchange",
  "symbol",
  "timeframe",
  "open_time",
  "close_time",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "turnover",
  "is_final",
  "ingested_at",
] as const;

export interface CandleInsertResult {
  received: number;
  inserted: number;
  updated: number;
}

interface CandleRow {
  symbol: string;
  timeframe: string;
  open_time: unknown;
  close_time: unknown;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
  is_final: boolean;
}

function availabilityKey(
  exchange: string,
  symbol: string,
  timeframe: string,
): string {
  return `${exchange}\u0000${symbol}\u0000${timeframe}`;
}

/**
 * Inserts candles idempotently.
 *
 * A non-final candle may be replaced by its finalized version, but a finalized
 * candle is never overwritten by a stale in-progress update.
 */
export async function insertCandles(
  connection: ResearchConnection,
  exchange: string,
  candles: Candle[],
): Promise<CandleInsertResult> {
  if (candles.length === 0) {
    return { received: 0, inserted: 0, updated: 0 };
  }

  const groups = new Map<string, Candle[]>();

  for (const candle of candles) {
    const key = availabilityKey(exchange, candle.symbol, candle.timeframe);
    const group = groups.get(key);

    if (group) group.push(candle);
    else groups.set(key, [candle]);
  }

  const ingestedAt = Date.now();
  let inserted = 0;
  let updated = 0;

  for (const group of groups.values()) {
    const [first] = group;
    if (!first) continue;

    for (let offset = 0; offset < group.length; offset += CANDLE_CHUNK_SIZE) {
      const chunk = group.slice(offset, offset + CANDLE_CHUNK_SIZE);

      const existingResult = await connection.runAndReadAll(
        `SELECT open_time FROM candles
         WHERE exchange = ? AND symbol = ? AND timeframe = ?
           AND open_time IN (${chunk.map(() => "?").join(", ")})`,
        [
          exchange,
          first.symbol,
          first.timeframe,
          ...chunk.map((candle) => candle.openTime),
        ],
      );

      const existing = new Set(
        existingResult
          .getRowObjects()
          .map((row) => toNumber((row as { open_time: unknown }).open_time)),
      );

      const values: DuckDBValue[] = chunk.flatMap((candle) => [
        exchange,
        candle.symbol,
        candle.timeframe,
        candle.openTime,
        candle.closeTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.turnover,
        candle.isFinal,
        ingestedAt,
      ]);

      await connection.run(
        `INSERT INTO candles (${CANDLE_COLUMNS.join(", ")})
         VALUES ${chunk.map(() => `(${CANDLE_COLUMNS.map(() => "?").join(", ")})`).join(", ")}
         ON CONFLICT (exchange, symbol, timeframe, open_time) DO UPDATE SET
           close_time = EXCLUDED.close_time,
           open = EXCLUDED.open,
           high = EXCLUDED.high,
           low = EXCLUDED.low,
           close = EXCLUDED.close,
           volume = EXCLUDED.volume,
           turnover = EXCLUDED.turnover,
           is_final = candles.is_final OR EXCLUDED.is_final,
           ingested_at = EXCLUDED.ingested_at
         WHERE EXCLUDED.is_final OR NOT candles.is_final`,
        values,
      );

      for (const candle of chunk) {
        if (existing.has(candle.openTime)) updated++;
        else inserted++;
      }
    }
  }

  return { received: candles.length, inserted, updated };
}

export async function getLastCandleOpenTime(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
): Promise<number | null> {
  const result = await connection.runAndReadAll(
    `SELECT MAX(open_time) AS last_open_time FROM candles
     WHERE exchange = ? AND symbol = ? AND timeframe = ?`,
    [exchange, symbol, timeframe],
  );

  const row = result.getRowObjects()[0] as
    | { last_open_time: unknown }
    | undefined;

  return row?.last_open_time === null || row?.last_open_time === undefined
    ? null
    : toNumber(row.last_open_time);
}

export async function getFirstCandleOpenTime(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
): Promise<number | null> {
  const result = await connection.runAndReadAll(
    `SELECT MIN(open_time) AS first_open_time FROM candles
     WHERE exchange = ? AND symbol = ? AND timeframe = ?`,
    [exchange, symbol, timeframe],
  );

  const row = result.getRowObjects()[0] as
    | { first_open_time: unknown }
    | undefined;

  return row?.first_open_time === null || row?.first_open_time === undefined
    ? null
    : toNumber(row.first_open_time);
}

export async function countCandles(
  connection: ResearchConnection,
  exchange: string,
  symbol?: string,
  timeframe?: string,
): Promise<number> {
  const filters = ["exchange = ?"];
  const params: DuckDBValue[] = [exchange];

  if (symbol) {
    filters.push("symbol = ?");
    params.push(symbol);
  }

  if (timeframe) {
    filters.push("timeframe = ?");
    params.push(timeframe);
  }

  const result = await connection.runAndReadAll(
    `SELECT COUNT(*) AS total FROM candles WHERE ${filters.join(" AND ")}`,
    params,
  );

  const row = result.getRowObjects()[0] as { total: unknown } | undefined;
  return toNumber(row?.total);
}

export async function loadCandles(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
  from?: number,
  to?: number,
): Promise<Candle[]> {
  const filters = ["exchange = ?", "symbol = ?", "timeframe = ?"];
  const params: DuckDBValue[] = [exchange, symbol, timeframe];

  if (from !== undefined) {
    filters.push("open_time >= ?");
    params.push(from);
  }

  if (to !== undefined) {
    filters.push("open_time <= ?");
    params.push(to);
  }

  const result = await connection.runAndReadAll(
    `SELECT * FROM candles
     WHERE ${filters.join(" AND ")}
     ORDER BY open_time`,
    params,
  );

  return (result.getRowObjects() as unknown as CandleRow[]).map((row) => ({
    symbol: row.symbol,
    timeframe: row.timeframe,
    openTime: toNumber(row.open_time),
    closeTime: toNumber(row.close_time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    turnover: row.turnover === null ? null : Number(row.turnover),
    isFinal: row.is_final,
  }));
}

export async function getCursor(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
): Promise<number | null> {
  const result = await connection.runAndReadAll(
    `SELECT last_open_time FROM ingestion_cursors
     WHERE exchange = ? AND symbol = ? AND timeframe = ?`,
    [exchange, symbol, timeframe],
  );

  const row = result.getRowObjects()[0] as
    | { last_open_time: unknown }
    | undefined;

  return row?.last_open_time === undefined
    ? null
    : toNumber(row.last_open_time);
}

export async function setCursor(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
  lastOpenTime: number,
): Promise<void> {
  await connection.run(
    `INSERT INTO ingestion_cursors
       (exchange, symbol, timeframe, last_open_time, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (exchange, symbol, timeframe) DO UPDATE SET
       last_open_time = EXCLUDED.last_open_time,
       updated_at = EXCLUDED.updated_at`,
    [exchange, symbol, timeframe, lastOpenTime, Date.now()],
  );
}

export interface IngestionRunResult {
  runId: string;
  status: "completed" | "failed";
  received: number;
  inserted: number;
  error?: string;
}

export async function beginIngestionRun(
  connection: ResearchConnection,
  exchange: string,
  symbol: string,
  timeframe: string,
  requestedFrom: number,
  requestedTo: number,
): Promise<string> {
  const runId = crypto.randomUUID();

  await connection.run(
    `INSERT INTO ingestion_runs
       (run_id, exchange, symbol, timeframe, requested_from, requested_to,
        started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    [runId, exchange, symbol, timeframe, requestedFrom, requestedTo, Date.now()],
  );

  return runId;
}

export async function finishIngestionRun(
  connection: ResearchConnection,
  runId: string,
  result: Omit<IngestionRunResult, "runId">,
): Promise<void> {
  await connection.run(
    `UPDATE ingestion_runs
     SET finished_at = ?, status = ?, candles_received = ?,
         candles_inserted = ?, error = ?
     WHERE run_id = ?`,
    [
      Date.now(),
      result.status,
      result.received,
      result.inserted,
      result.error ?? null,
      runId,
    ],
  );
}
