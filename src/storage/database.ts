import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Dedicated DuckDB for the exchange-agnostic research engine. Keeping it
 * separate from `signals.duckdb` means a crypto research run cannot disturb
 * the live Phase 7 paper-trading state.
 */
export const RESEARCH_DATABASE_PATH =
  process.env.RESEARCH_DATABASE_PATH ?? "./data/research.duckdb";

export type ResearchConnection = DuckDBConnection;

export interface OpenResearchDatabaseOptions {
  path?: string;
  readOnly?: boolean;
}

const SCHEMA_VERSION = 1;

/**
 * Opens the research database and ensures the Phase 2 schema exists. Safe to
 * call repeatedly; every statement is idempotent.
 */
export async function openResearchDatabase(
  options: OpenResearchDatabaseOptions = {},
): Promise<ResearchConnection> {
  const path = options.path ?? RESEARCH_DATABASE_PATH;

  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }

  const instance = await DuckDBInstance.create(path, {
    ...(options.readOnly ? { access_mode: "READ_ONLY" } : {}),
  });
  const connection = await instance.connect();

  if (!options.readOnly) {
    await ensureSchema(connection);
  }

  return connection;
}

export async function ensureSchema(
  connection: ResearchConnection,
): Promise<void> {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS markets (
      exchange VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      exchange_symbol VARCHAR NOT NULL,
      base VARCHAR NOT NULL,
      quote VARCHAR NOT NULL,
      settle VARCHAR NOT NULL,
      type VARCHAR NOT NULL,
      linear BOOLEAN NOT NULL,
      inverse BOOLEAN NOT NULL,
      contract BOOLEAN NOT NULL,
      active BOOLEAN NOT NULL,
      contract_size DOUBLE,
      price_tick DOUBLE,
      amount_step DOUBLE,
      min_amount DOUBLE,
      max_amount DOUBLE,
      min_cost DOUBLE,
      min_leverage DOUBLE,
      max_leverage DOUBLE,
      initial_margin_rate DOUBLE,
      maintenance_margin_rate DOUBLE,
      maker_fee DOUBLE,
      taker_fee DOUBLE,
      raw_json VARCHAR,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (exchange, symbol)
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS candles (
      exchange VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      open_time BIGINT NOT NULL,
      close_time BIGINT NOT NULL,
      open DOUBLE NOT NULL,
      high DOUBLE NOT NULL,
      low DOUBLE NOT NULL,
      close DOUBLE NOT NULL,
      volume DOUBLE NOT NULL,
      turnover DOUBLE,
      is_final BOOLEAN NOT NULL,
      ingested_at BIGINT NOT NULL,
      PRIMARY KEY (exchange, symbol, timeframe, open_time)
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS ingestion_cursors (
      exchange VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      last_open_time BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (exchange, symbol, timeframe)
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      run_id VARCHAR PRIMARY KEY,
      exchange VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      timeframe VARCHAR NOT NULL,
      requested_from BIGINT NOT NULL,
      requested_to BIGINT NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT,
      status VARCHAR NOT NULL,
      candles_received BIGINT NOT NULL DEFAULT 0,
      candles_inserted BIGINT NOT NULL DEFAULT 0,
      error VARCHAR
    )
  `);

  await connection.run(
    `INSERT INTO schema_migrations (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
    [SCHEMA_VERSION, Date.now()],
  );
}

/** Converts DuckDB BIGINT results into JS numbers. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value === null || value === undefined) return 0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
