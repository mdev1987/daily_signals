import type { MarketInterface } from "ccxt";
import type { MarketInfo, MarketType } from "../exchange.types";
import {
  selectUniverse,
  splitSymbolList,
} from "../market-universe";

export { splitSymbolList };

/**
 * Lighter perpetuals are linear contracts quoted and settled in USDC. Both must
 * match: a market quoted in one currency and settled in another is not the
 * contract the research engine models.
 */
export const ELIGIBLE_SETTLE = "USDC";
export const ELIGIBLE_QUOTE = "USDC";

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

function positive(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readType(value: unknown): MarketType {
  if (value === "spot" || value === "future" || value === "swap") return value;
  return "swap";
}

/** Basis points conversion: Lighter reports margin fractions in 1/10000. */
function marginRate(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : parsed / 10_000;
}

function stepFromDecimals(value: unknown): number | null {
  const decimals = toNumber(value);
  if (decimals === null || decimals < 0 || !Number.isInteger(decimals)) {
    return null;
  }
  return 10 ** -decimals;
}

interface RawLighterMarket {
  market_type?: unknown;
  status?: unknown;
  is_frozen?: unknown;
  min_base_amount?: unknown;
  min_quote_amount?: unknown;
  price_decimals?: unknown;
  size_decimals?: unknown;
  multiplier?: unknown;
  default_initial_margin_fraction?: unknown;
  min_initial_margin_fraction?: unknown;
  maintenance_margin_fraction?: unknown;
}

/**
 * Converts a CCXT Lighter market into the internal representation.
 *
 * Lighter reports margin settings as basis-point-style integers (500 = 5%) and
 * occasionally omits a field when it is zero, so every read is defensive.
 */
export function normalizeLighterMarket(
  exchange: string,
  market: MarketInterface,
): MarketInfo | null {
  if (!market.symbol || !market.base || !market.quote || !market.settle) {
    return null;
  }

  const raw = (market.info ?? {}) as RawLighterMarket;
  const frozen = raw.is_frozen === true;
  const active = market.active !== false && !frozen;

  const initialMarginRate = marginRate(raw.default_initial_margin_fraction);
  const maxLeverageRaw = positive(raw.min_initial_margin_fraction);

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
    // Lighter multipliers are 1: one contract is one unit of the base asset.
    contractSize: positive(raw.multiplier) ?? 1,
    priceTick:
      toNumber(market.precision?.price ?? null) ??
      stepFromDecimals(raw.price_decimals),
    amountStep:
      toNumber(market.precision?.amount ?? null) ??
      stepFromDecimals(raw.size_decimals),
    minAmount:
      toNumber(market.limits?.amount?.min ?? null) ??
      toNumber(raw.min_base_amount),
    maxAmount: toNumber(market.limits?.amount?.max ?? null),
    minCost:
      toNumber(market.limits?.cost?.min ?? null) ??
      toNumber(raw.min_quote_amount),
    minLeverage: 1,
    maxLeverage:
      maxLeverageRaw === null ? null : 10_000 / maxLeverageRaw,
    initialMarginRate,
    maintenanceMarginRate: marginRate(raw.maintenance_margin_fraction),
    // CCXT exposes documented default rates, not account-specific rates.
    makerFee: toNumber(market.maker ?? null),
    takerFee: toNumber(market.taker ?? null),
    raw: market.info ?? null,
  };
}

export function isEligibleLighterPerpetual(market: MarketInfo): boolean {
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
 * eligible market; otherwise the default majors are used.
 */
export function selectInitialUniverse(
  markets: MarketInfo[],
  requestedSymbols: string[] = [],
  limit: number = DEFAULT_UNIVERSE.length,
): MarketInfo[] {
  return selectUniverse(
    markets,
    isEligibleLighterPerpetual,
    DEFAULT_UNIVERSE,
    requestedSymbols,
    limit,
  );
}
