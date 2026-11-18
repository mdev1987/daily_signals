import type { MarketInterface } from "ccxt";
import type { MarketInfo, MarketType } from "../exchange.types";
import {
  selectUniverse,
  splitSymbolList,
} from "../market-universe";

export { splitSymbolList };

/** Markets we consider usable by the research engine. */
export const ELIGIBLE_SETTLE = "USDT";

/**
 * Liquid majors used when no explicit universe is configured. Every entry is
 * matched against markets actually returned by the exchange; unknown names are
 * skipped rather than guessed.
 */
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

interface RawApexMarket {
  minOrderSize?: unknown;
  maxOrderSize?: unknown;
  stepSize?: unknown;
  tickSize?: unknown;
  displayMinLeverage?: unknown;
  displayMaxLeverage?: unknown;
  initialMarginRate?: unknown;
  defaultInitialMarginRate?: unknown;
  maintenanceMarginRate?: unknown;
  minNotional?: unknown;
}

/**
 * Converts a CCXT ApeX market into the internal representation. ApeX has no
 * separate contract multiplier: order sizes are expressed in base units, so
 * contractSize is 1 and the minimum size is carried by minAmount.
 */
export function normalizeApexMarket(
  exchange: string,
  market: MarketInterface,
): MarketInfo | null {
  if (!market.symbol || !market.base || !market.quote || !market.settle) {
    return null;
  }

  const raw = (market.info ?? {}) as RawApexMarket;

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
    active: Boolean(market.active),
    contractSize: 1,
    priceTick:
      toNumber(raw.tickSize) ?? toNumber(market.precision?.price ?? null),
    amountStep:
      toNumber(raw.stepSize) ?? toNumber(market.precision?.amount ?? null),
    minAmount:
      toNumber(raw.minOrderSize) ?? toNumber(market.limits?.amount?.min ?? null),
    maxAmount:
      toNumber(raw.maxOrderSize) ?? toNumber(market.limits?.amount?.max ?? null),
    minCost: toNumber(raw.minNotional),
    minLeverage: toNumber(raw.displayMinLeverage),
    maxLeverage: toNumber(raw.displayMaxLeverage),
    initialMarginRate:
      toNumber(raw.initialMarginRate) ??
      toNumber(raw.defaultInitialMarginRate),
    maintenanceMarginRate: toNumber(raw.maintenanceMarginRate),
    // CCXT exposes documented default rates, not account-specific rates.
    makerFee: toNumber(market.maker ?? null),
    takerFee: toNumber(market.taker ?? null),
    raw: market.info ?? null,
  };
}

export function isEligibleApexPerpetual(market: MarketInfo): boolean {
  return (
    market.type === "swap" &&
    market.linear &&
    !market.inverse &&
    market.contract &&
    market.active &&
    market.settle.toUpperCase() === ELIGIBLE_SETTLE &&
    market.quote.toUpperCase() === ELIGIBLE_SETTLE
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
    isEligibleApexPerpetual,
    DEFAULT_UNIVERSE,
    requestedSymbols,
    limit,
  );
}
