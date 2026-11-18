import type { DuckDBValue } from "@duckdb/node-api";
import type { MarketInfo } from "../../exchanges/exchange.types";
import { toNumber, type ResearchConnection } from "../database";

const MARKET_COLUMNS = [
  "exchange",
  "symbol",
  "exchange_symbol",
  "base",
  "quote",
  "settle",
  "type",
  "linear",
  "inverse",
  "contract",
  "active",
  "contract_size",
  "price_tick",
  "amount_step",
  "min_amount",
  "max_amount",
  "min_cost",
  "min_leverage",
  "max_leverage",
  "initial_margin_rate",
  "maintenance_margin_rate",
  "maker_fee",
  "taker_fee",
  "raw_json",
  "updated_at",
] as const;

const MARKET_CHUNK_SIZE = 100;

export interface MarketCounts {
  total: number;
  active: number;
  eligible: number;
}

function marketValues(market: MarketInfo, updatedAt: number): DuckDBValue[] {
  return [
    market.exchange,
    market.symbol,
    market.exchangeSymbol,
    market.base,
    market.quote,
    market.settle,
    market.type,
    market.linear,
    market.inverse,
    market.contract,
    market.active,
    market.contractSize,
    market.priceTick,
    market.amountStep,
    market.minAmount,
    market.maxAmount,
    market.minCost,
    market.minLeverage,
    market.maxLeverage,
    market.initialMarginRate,
    market.maintenanceMarginRate,
    market.makerFee,
    market.takerFee,
    market.raw === null || market.raw === undefined
      ? null
      : JSON.stringify(market.raw),
    updatedAt,
  ];
}

/** Idempotent upsert of market metadata keyed by (exchange, symbol). */
export async function upsertMarkets(
  connection: ResearchConnection,
  markets: MarketInfo[],
): Promise<number> {
  if (markets.length === 0) return 0;

  const updatedAt = Date.now();
  const placeholder = `(${MARKET_COLUMNS.map(() => "?").join(", ")})`;
  const updates = MARKET_COLUMNS.filter(
    (column) => column !== "exchange" && column !== "symbol",
  )
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(",\n        ");

  for (let offset = 0; offset < markets.length; offset += MARKET_CHUNK_SIZE) {
    const chunk = markets.slice(offset, offset + MARKET_CHUNK_SIZE);
    const values = chunk.flatMap((market) => marketValues(market, updatedAt));

    await connection.run(
      `INSERT INTO markets (${MARKET_COLUMNS.join(", ")})
       VALUES ${chunk.map(() => placeholder).join(", ")}
       ON CONFLICT (exchange, symbol) DO UPDATE SET
        ${updates}`,
      values,
    );
  }

  return markets.length;
}

interface MarketRow {
  exchange: string;
  symbol: string;
  exchange_symbol: string;
  base: string;
  quote: string;
  settle: string;
  type: string;
  linear: boolean;
  inverse: boolean;
  contract: boolean;
  active: boolean;
  contract_size: number | null;
  price_tick: number | null;
  amount_step: number | null;
  min_amount: number | null;
  max_amount: number | null;
  min_cost: number | null;
  min_leverage: number | null;
  max_leverage: number | null;
  initial_margin_rate: number | null;
  maintenance_margin_rate: number | null;
  maker_fee: number | null;
  taker_fee: number | null;
  raw_json: string | null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadMarkets(
  connection: ResearchConnection,
  exchange?: string,
): Promise<MarketInfo[]> {
  const result = exchange
    ? await connection.runAndReadAll(
        "SELECT * FROM markets WHERE exchange = ? ORDER BY symbol",
        [exchange],
      )
    : await connection.runAndReadAll("SELECT * FROM markets ORDER BY symbol");

  return (result.getRowObjects() as unknown as MarketRow[]).map((row) => ({
    exchange: row.exchange,
    symbol: row.symbol,
    exchangeSymbol: row.exchange_symbol,
    base: row.base,
    quote: row.quote,
    settle: row.settle,
    type: row.type as MarketInfo["type"],
    linear: row.linear,
    inverse: row.inverse,
    contract: row.contract,
    active: row.active,
    contractSize: nullableNumber(row.contract_size),
    priceTick: nullableNumber(row.price_tick),
    amountStep: nullableNumber(row.amount_step),
    minAmount: nullableNumber(row.min_amount),
    maxAmount: nullableNumber(row.max_amount),
    minCost: nullableNumber(row.min_cost),
    minLeverage: nullableNumber(row.min_leverage),
    maxLeverage: nullableNumber(row.max_leverage),
    initialMarginRate: nullableNumber(row.initial_margin_rate),
    maintenanceMarginRate: nullableNumber(row.maintenance_margin_rate),
    makerFee: nullableNumber(row.maker_fee),
    takerFee: nullableNumber(row.taker_fee),
    raw: row.raw_json ? JSON.parse(row.raw_json) : null,
  }));
}

export async function countMarkets(
  connection: ResearchConnection,
  exchange = "apex",
): Promise<MarketCounts> {
  const result = await connection.runAndReadAll(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE active) AS active,
       COUNT(*) FILTER (
         WHERE active
           AND type = 'swap'
           AND linear
           AND NOT inverse
           AND contract
           AND settle = 'USDT'
           AND quote = 'USDT'
       ) AS eligible
     FROM markets
     WHERE exchange = ?`,
    [exchange],
  );

  const row = result.getRowObjects()[0] as
    | { total: unknown; active: unknown; eligible: unknown }
    | undefined;

  return {
    total: toNumber(row?.total),
    active: toNumber(row?.active),
    eligible: toNumber(row?.eligible),
  };
}
