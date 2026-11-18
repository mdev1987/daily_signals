import { ExchangeConfigurationError } from "./exchange.errors";
import type { MarketInfo } from "./exchange.types";

/** Parses the comma-separated symbol lists used by the ingestion CLIs. */
export function splitSymbolList(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Accepts a unified symbol (`BTC/USDT:USDT`), a venue-native id
 * (`BTC-USD-PERP`) or a bare base asset (`BTC`).
 */
export function matchesRequestedSymbol(
  market: MarketInfo,
  requested: string,
): boolean {
  const needle = requested.trim().toUpperCase();
  const compact = needle.replace(/[^A-Z0-9]/g, "");

  return (
    market.symbol.toUpperCase() === needle ||
    market.exchangeSymbol.toUpperCase() === needle ||
    market.base.toUpperCase() === needle ||
    market.exchangeSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "") === compact
  );
}

/**
 * Resolves the research universe for a venue supplied eligibility predicate.
 *
 * Explicit requests must resolve to an eligible market, otherwise the run
 * fails. Without explicit requests the venue's default majors are used, and if
 * none of those exist the eligible universe is taken alphabetically.
 */
export function selectUniverse(
  markets: MarketInfo[],
  isEligible: (market: MarketInfo) => boolean,
  defaultUniverse: readonly string[],
  requestedSymbols: string[] = [],
  limit: number = defaultUniverse.length,
): MarketInfo[] {
  const eligible = markets.filter(isEligible);

  if (requestedSymbols.length > 0) {
    const selected: MarketInfo[] = [];

    for (const requested of requestedSymbols) {
      const match = eligible.find((market) =>
        matchesRequestedSymbol(market, requested),
      );

      if (!match) {
        throw new ExchangeConfigurationError(
          `Requested symbol "${requested}" is not an active eligible perpetual`,
        );
      }

      if (!selected.some((market) => market.symbol === match.symbol)) {
        selected.push(match);
      }
    }

    return selected.slice(0, Math.max(1, limit));
  }

  const byName = new Map(
    eligible.map((market) => [market.base.toUpperCase(), market]),
  );
  const defaults = defaultUniverse
    .map((base) => byName.get(base.toUpperCase()))
    .filter((market): market is MarketInfo => Boolean(market));

  if (defaults.length > 0) return defaults.slice(0, Math.max(1, limit));

  return [...eligible]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(1, limit));
}
