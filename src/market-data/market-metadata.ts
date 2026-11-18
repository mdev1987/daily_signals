import type {
  ExchangeAdapter,
  MarketInfo,
} from "../exchanges/exchange.types";
import {
  resolveExchangeProfile,
  type ExchangeProfile,
} from "../exchanges/exchange.profile";
import { splitSymbolList } from "../exchanges/market-universe";
import { createExchangeAdapter } from "../exchanges/exchange.factory";
import { countMarkets, upsertMarkets } from "../storage/repositories/market.repository";
import {
  openResearchDatabase,
  type ResearchConnection,
} from "../storage/database";

export interface MarketSyncOptions {
  requestedSymbols?: string[];
  universeSize?: number;
  profile?: ExchangeProfile;
}

export interface MarketSyncResult {
  exchange: string;
  profile: ExchangeProfile;
  markets: MarketInfo[];
  eligible: MarketInfo[];
  universe: MarketInfo[];
  saved: number;
  counts: {
    total: number;
    active: number;
    eligible: number;
  };
}

function readEnv(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return env[name];
}

/**
 * Fetches market metadata, filters the venue's tradable perpetuals and
 * persists the full snapshot. Safe to run repeatedly.
 */
export async function syncMarketMetadata(
  adapter: ExchangeAdapter,
  connection: ResearchConnection,
  options: MarketSyncOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<MarketSyncResult> {
  const profile = options.profile ?? resolveExchangeProfile(adapter.id);
  const markets = await adapter.getMarkets();
  const requestedSymbols =
    options.requestedSymbols ??
    splitSymbolList(readEnv(env, profile.env.symbols));
  const universeSize =
    options.universeSize ?? Number(readEnv(env, profile.env.universeSize) ?? 10);

  const saved = await upsertMarkets(connection, markets);
  const counts = await countMarkets(
    connection,
    adapter.id,
    profile.eligibleSettle,
    profile.eligibleQuote,
  );

  return {
    exchange: adapter.id,
    profile,
    markets,
    eligible: markets.filter(profile.isEligible),
    universe: profile.selectUniverse(markets, requestedSymbols, universeSize),
    saved,
    counts,
  };
}

export function formatMarketReport(result: MarketSyncResult): string {
  const { profile } = result;
  const lines = [
    `=== ${profile.label.toUpperCase()} MARKET DATA REPORT ===`,
    "",
    `Exchange:        ${result.exchange}`,
    `Environment:     ${profile.describe().environment}`,
    `Market Type:     ${profile.marketTypeLabel}`,
    "",
    `Total Markets:    ${result.counts.total}`,
    `Active Markets:   ${result.counts.active}`,
    `Eligible Markets: ${result.counts.eligible}`,
    `Persisted:       ${result.saved}`,
    "",
    `Initial Universe (${result.universe.length}):`,
  ];

  for (const market of result.universe) {
    const tick = market.priceTick ?? "n/a";
    const step = market.amountStep ?? "n/a";
    const minimums: string[] = [];
    if (market.minAmount !== null) {
      minimums.push(`amount=${market.minAmount}`);
    }
    if (market.minCost !== null) {
      minimums.push(`notional=${market.minCost}`);
    }
    const min = minimums.length > 0 ? minimums.join(",") : "n/a";

    lines.push(
      `  - ${market.symbol} (${market.exchangeSymbol}) tick=${tick} step=${step} min=${min}`,
    );
  }

  if (result.universe.length === 0) {
    lines.push(
      `  (none; default majors: ${profile.defaultUniverse.join(", ")})`,
    );
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const profile = resolveExchangeProfile();
  const adapter = createExchangeAdapter({ exchange: profile.id });
  const connection = await openResearchDatabase();

  await adapter.connect();

  try {
    const result = await syncMarketMetadata(adapter, connection, { profile });
    console.log(formatMarketReport(result));
  } finally {
    await adapter.close();
  }
}
