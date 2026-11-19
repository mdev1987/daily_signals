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

/** Strips separators so `BTC/USD`, `BTCUSD` and `btc-usd` compare equal. */
export function normalizeLighterBase(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Lookup built from the venue's own market list. Lighter lists whatever it
 * chooses to list (crypto, FX, metals, equities, indices) and changes it
 * without notice, so symbols resolve against this index instead of a hardcoded
 * universe.
 */
export interface LighterMarketIndex {
  /** Venue symbol, e.g. `EURUSD/USDC:USDC` -> market. */
  bySymbol: Map<string, MarketInfo>;
  /** Quote-stripped key, e.g. `EURUSD`, `BTC`, `XAU` -> market. */
  byBase: Map<string, MarketInfo>;
}

export function buildLighterMarketIndex(
  markets: readonly MarketInfo[],
): LighterMarketIndex {
  const bySymbol = new Map<string, MarketInfo>();
  const byBase = new Map<string, MarketInfo>();

  for (const market of markets) {
    if (!isEligibleLighterPerpetual(market)) continue;

    bySymbol.set(market.symbol, market);

    const keys = [
      normalizeLighterBase(market.base),
      normalizeLighterBase(market.symbol.split("/")[0] ?? ""),
    ];

    for (const key of keys) {
      if (key && !byBase.has(key)) byBase.set(key, market);
    }
  }

  return { bySymbol, byBase };
}

const QUOTE_SUFFIXES = ["USDC", "USDT", "USD"] as const;

/**
 * Resolves a signal-side or canonical symbol (`EUR/USD`, `XAUUSD`, `BTC`) to
 * the venue market that represents it. Exact matches win, so `EURUSD` maps to
 * the EURUSD perpetual rather than to anything with an EUR base. Only a quote
 * suffix is peeled off, so `BTC/ZAR` never resolves to `BTC`.
 */
export function resolveLighterMarket(
  symbol: string,
  index: LighterMarketIndex,
): MarketInfo | null {
  const normalized = normalizeLighterBase(symbol);
  if (!normalized) return null;

  const direct = index.byBase.get(normalized);
  if (direct) return direct;

  for (const suffix of QUOTE_SUFFIXES) {
    if (!normalized.endsWith(suffix)) continue;
    if (normalized.length === suffix.length) continue;

    const stripped = index.byBase.get(normalized.slice(0, -suffix.length));
    if (stripped) return stripped;
  }

  return null;
}

/**
 * Floors a base quantity to the market's amount step. Lighter rejects orders
 * with more decimals than the market supports, so rounding down is the only
 * safe direction for an opening order.
 */
export function floorToAmountStep(
  quantity: number,
  step: number | null,
): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (step === null || !Number.isFinite(step) || step <= 0) return quantity;

  const decimals = Math.max(
    0,
    Math.min(12, Math.round(-Math.log10(step))),
  );
  const factor = 10 ** decimals;

  return Math.floor(quantity * factor) / factor;
}
