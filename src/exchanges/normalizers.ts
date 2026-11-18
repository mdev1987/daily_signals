import type {
  BalanceEntry,
  Candle,
  FundingRate,
  Order,
  OrderBook,
  OrderBookLevel,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  PositionSide,
  Ticker,
  Trade,
} from "./exchange.types";
import { timeframeToMs } from "../market-data/timeframes";

export { timeframeToMs };

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampTimestamp(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export type RawOhlcv = readonly (number | string | null | undefined)[];

export interface NormalizeCandleOptions {
  /**
   * Widen `high`/`low` so they always contain `open` and `close`.
   *
   * Paradex carries the previous close into `open` while `high`/`low` only
   * cover trades inside the interval, so the open can legitimately sit outside
   * the reported range. Because open and close are both traded prices, the
   * interval high/low cannot be tighter than them; widening is a correction,
   * not a fabrication. Strict venues leave this disabled.
   */
  widenRange?: boolean;
  /**
   * Treat a missing volume as zero.
   *
   * Lighter omits fields whose value is zero, so an interval without trades
   * arrives with `v` absent. The price candle is still real; dropping it would
   * invent a gap. Only enable this for venues that document the omission.
   */
  zeroMissingVolume?: boolean;
}

/**
 * Normalizes one OHLCV row. Returns null for structurally invalid candles so
 * a single bad row cannot poison an ingestion run.
 */
export function normalizeCandle(
  row: RawOhlcv,
  symbol: string,
  timeframe: string,
  now = Date.now(),
  options: NormalizeCandleOptions = {},
): Candle | null {
  if (row.length < 6) return null;

  const openTime = finite(row[0]);
  const open = finite(row[1]);
  const high = finite(row[2]);
  const low = finite(row[3]);
  const close = finite(row[4]);
  const volume =
    finite(row[5]) ?? (options.zeroMissingVolume ? 0 : null);

  if (
    openTime === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }

  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (volume < 0) return null;

  const rangeHigh = options.widenRange
    ? Math.max(high, open, close)
    : high;
  const rangeLow = options.widenRange
    ? Math.min(low, open, close)
    : low;

  if (rangeHigh < rangeLow) return null;
  if (rangeHigh < Math.max(open, close)) return null;
  if (rangeLow > Math.min(open, close)) return null;

  const interval = timeframeToMs(timeframe);

  return {
    symbol,
    timeframe,
    openTime: Math.trunc(openTime),
    closeTime: Math.trunc(openTime) + interval,
    open,
    high: rangeHigh,
    low: rangeLow,
    close,
    volume,
    turnover: null,
    isFinal: Math.trunc(openTime) + interval <= now,
  };
}

export interface RawTicker {
  symbol?: string;
  timestamp?: number | null;
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  high?: number | null;
  low?: number | null;
  baseVolume?: number | null;
  quoteVolume?: number | null;
}

export function normalizeTicker(raw: RawTicker, symbol: string): Ticker {
  return {
    symbol: raw.symbol ?? symbol,
    timestamp: clampTimestamp(raw.timestamp),
    last: finite(raw.last),
    bid: finite(raw.bid),
    ask: finite(raw.ask),
    high: finite(raw.high),
    low: finite(raw.low),
    volume: finite(raw.baseVolume),
    raw,
  };
}

export interface RawOrderBook {
  symbol?: string;
  timestamp?: number | null;
  bids?: RawOrderBookLevel[];
  asks?: RawOrderBookLevel[];
}

type RawOrderBookLevel = readonly (number | string | null | undefined)[];

function normalizeLevels(
  levels: RawOrderBookLevel[] | undefined,
): OrderBookLevel[] {
  const result: OrderBookLevel[] = [];

  for (const level of levels ?? []) {
    const price = finite(level[0]);
    const amount = finite(level[1]);

    if (price === null || amount === null || price <= 0 || amount <= 0) continue;

    result.push({ price, amount });
  }

  return result;
}

export function normalizeOrderBook(
  raw: RawOrderBook,
  symbol: string,
): OrderBook {
  return {
    symbol: raw.symbol ?? symbol,
    timestamp: clampTimestamp(raw.timestamp),
    bids: normalizeLevels(raw.bids),
    asks: normalizeLevels(raw.asks),
  };
}

export interface RawTrade {
  id?: string | null;
  symbol?: string;
  side?: string | null;
  price?: number | null;
  amount?: number | null;
  timestamp?: number | null;
}

function normalizeSide(value: unknown): OrderSide | null {
  if (value === "buy" || value === "sell") return value;
  return null;
}

export function normalizeTrade(raw: RawTrade, symbol: string): Trade | null {
  const price = finite(raw.price);
  const amount = finite(raw.amount);

  if (price === null || amount === null || price <= 0 || amount <= 0) {
    return null;
  }

  return {
    id: raw.id ?? null,
    symbol: raw.symbol ?? symbol,
    side: normalizeSide(raw.side),
    price,
    amount,
    timestamp: clampTimestamp(raw.timestamp),
    raw,
  };
}

export interface RawFundingRate {
  symbol?: string;
  timestamp?: number | null;
  fundingRate?: number | null;
}

export function normalizeFundingRate(
  raw: RawFundingRate,
  symbol: string,
): FundingRate | null {
  const rate = finite(raw.fundingRate);
  if (rate === null) return null;

  return {
    symbol: raw.symbol ?? symbol,
    timestamp: clampTimestamp(raw.timestamp),
    rate,
    raw,
  };
}

export interface RawBalances {
  total?: Record<string, number | undefined>;
  free?: Record<string, number | undefined>;
  used?: Record<string, number | undefined>;
}

export function normalizeBalance(raw: RawBalances): BalanceEntry[] {
  const currencies = new Set([
    ...Object.keys(raw.total ?? {}),
    ...Object.keys(raw.free ?? {}),
    ...Object.keys(raw.used ?? {}),
  ]);

  const entries: BalanceEntry[] = [];

  for (const currency of [...currencies].sort()) {
    const total = finite(raw.total?.[currency]) ?? 0;
    const free = finite(raw.free?.[currency]) ?? 0;
    const used = finite(raw.used?.[currency]) ?? 0;

    if (total === 0 && free === 0 && used === 0) continue;

    entries.push({ currency, total, free, used });
  }

  return entries;
}

export interface RawPosition {
  symbol?: string;
  side?: string | null;
  contracts?: number | null;
  contractSize?: number | null;
  entryPrice?: number | null;
  markPrice?: number | null;
  liquidationPrice?: number | null;
  unrealizedPnl?: number | null;
  leverage?: number | null;
}

function normalizePositionSide(value: unknown): PositionSide | null {
  return value === "long" || value === "short" ? value : null;
}

export function normalizePosition(raw: RawPosition): Position | null {
  const symbol = raw.symbol;
  const side = normalizePositionSide(raw.side);

  if (!symbol || !side) return null;

  const contracts = finite(raw.contracts) ?? 0;
  if (contracts === 0) return null;

  return {
    symbol,
    side,
    contracts,
    contractSize: finite(raw.contractSize),
    entryPrice: finite(raw.entryPrice),
    markPrice: finite(raw.markPrice),
    liquidationPrice: finite(raw.liquidationPrice),
    unrealizedPnl: finite(raw.unrealizedPnl),
    leverage: finite(raw.leverage),
    raw,
  };
}

export interface RawOrder {
  id?: string | null;
  clientOrderId?: string | null;
  symbol?: string;
  type?: string | null;
  side?: string | null;
  price?: number | null;
  amount?: number | null;
  filled?: number | null;
  remaining?: number | null;
  status?: string | null;
  timestamp?: number | null;
}

const ORDER_STATUSES: Record<string, OrderStatus> = {
  open: "open",
  closed: "closed",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
  rejected: "rejected",
};

function normalizeStatus(value: unknown): OrderStatus {
  if (typeof value === "string" && value in ORDER_STATUSES) {
    return ORDER_STATUSES[value]!;
  }
  return "unknown";
}

function normalizeOrderType(value: unknown): OrderType {
  return value === "limit" ? "limit" : "market";
}

export function normalizeOrder(raw: RawOrder): Order | null {
  const symbol = raw.symbol;
  const side = normalizeSide(raw.side);

  if (!symbol || !side) return null;

  return {
    id: raw.id ?? null,
    clientOrderId: raw.clientOrderId ?? null,
    symbol,
    type: normalizeOrderType(raw.type),
    side,
    price: finite(raw.price),
    amount: finite(raw.amount),
    filled: finite(raw.filled),
    remaining: finite(raw.remaining),
    status: normalizeStatus(raw.status),
    timestamp: clampTimestamp(raw.timestamp),
    raw,
  };
}

/**
 * Removes accidentally echoed credentials from exchange error messages.
 * Empty secrets are ignored so a missing config cannot blank the whole message.
 */
export function redactMessage(
  message: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let output = message.replace(
    /(api_?key|secret|passphrase|private_?key)=[^\]\s,&]+/gi,
    "$1=<redacted>",
  );

  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join("<redacted>");
    }
  }

  return output;
}
