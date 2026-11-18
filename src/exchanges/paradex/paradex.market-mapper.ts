import type { MarketInterface } from "ccxt";
import type { MarketInfo, MarketType } from "../exchange.types";
import {
  selectUniverse,
  splitSymbolList,
} from "../market-universe";

export { splitSymbolList };

/**
 * Paradex perpetuals are quoted in USD and settled in USDC. Both must match:
 * a market quoted in one currency and settled in another is not the linear
 * USDC contract the research engine models.
 */
export const ELIGIBLE_SETTLE = "USDC";
export const ELIGIBLE_QUOTE = "USD";

export const DEFAULT_UNIVERSE = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "LTC",
] as const;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readType(value: unknown): MarketType {
  if (value === "spot" || value === "future" || value === "swap") return value;
  return "swap";
}

interface RawParadexMarket {
  price_tick_size?: unknown;
  order_size_increment?: unknown;
  min_notional?: unknown;
  max_order_size?: unknown;
  asset_kind?: unknown;
  expiry_at?: unknown;
  delta1_cross_margin_params?: {
    imf_base?: unknown;
    mmf_factor?: unknown;
  };
}

/**
 * Converts a CCXT Paradex market into the internal representation.
 *
 * Paradex does not return an `active` flag through CCXT for markets that are
 * currently listed, so `undefined` is treated as active. A market reported as
 * explicitly inactive, expired, or not a perpetual is excluded.
 */
export function normalizeParadexMarket(
  exchange: string,
  market: MarketInterface,
): MarketInfo | null {
  if (!market.symbol || !market.base || !market.quote || !market.settle) {
    return null;
  }

  const raw = (market.info ?? {}) as RawParadexMarket;
  const assetKind = typeof raw.asset_kind === "string" ? raw.asset_kind : null;
  const expiry = toNumber(raw.expiry_at);
  const isPerpetual =
    assetKind === null || assetKind.toUpperCase() === "PERP";
  const isExpired = expiry !== null && expiry > 0 && expiry <= Date.now();
  const active =
    market.active !== false && isPerpetual && !isExpired;

  const initialMarginRate = toNumber(
    raw.delta1_cross_margin_params?.imf_base,
  );
  const mmfFactor = toNumber(raw.delta1_cross_margin_params?.mmf_factor);

  return {
    exchange,
    symbol: market.symbol,
    exchangeSymbol: market.id ?? market.symbol,
    base: market.base,
    quote: market.quote,
    settle: market.settle,
    type: readType(market.type),
    linear: Boolean(market.linear),
    inverse: Boolean(market.inverse),
    contract: Boolean(market.contract),
    active,
    contractSize: 1,
    priceTick:
      toNumber(raw.price_tick_size) ??
      toNumber(market.precision?.price ?? null),
    amountStep:
      toNumber(raw.order_size_increment) ??
      toNumber(market.precision?.amount ?? null),
    minAmount: toNumber(market.limits?.amount?.min ?? null),
    maxAmount:
      toNumber(raw.max_order_size) ??
      toNumber(market.limits?.amount?.max ?? null),
    minCost:
      toNumber(raw.min_notional) ??
      toNumber(market.limits?.cost?.min ?? null),
    minLeverage: toNumber(market.limits?.leverage?.min ?? null),
    maxLeverage: toNumber(market.limits?.leverage?.max ?? null),
    initialMarginRate,
    maintenanceMarginRate:
      initialMarginRate !== null && mmfFactor !== null
        ? initialMarginRate * mmfFactor
        : null,
    // CCXT exposes documented default rates, not account-specific rates.
    makerFee: toNumber(market.maker ?? null),
    takerFee: toNumber(market.taker ?? null),
    raw: market.info ?? null,
  };
}

export function isEligibleParadexPerpetual(market: MarketInfo): boolean {
  return (
    market.type === "swap" &&
    market.linear &&
    !market.inverse &&
    market.contract &&
    market.active &&
    market.settle.toUpperCase() === ELIGIBLE_SETTLE &&
    market.quote.toUpperCase() === ELIGIBLE_QUOTE
  );
}

/**
 * Resolves the initial trading universe. Explicit requests must resolve to an
 * eligible market; otherwise the default majors list is used.
 */
export function selectInitialUniverse(
  markets: MarketInfo[],
  requestedSymbols: string[] = [],
  limit: number = DEFAULT_UNIVERSE.length,
): MarketInfo[] {
  return selectUniverse(
    markets,
    isEligibleParadexPerpetual,
    DEFAULT_UNIVERSE,
    requestedSymbols,
    limit,
  );
}
