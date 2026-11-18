import type {
  ExchangeAdapter,
  MarketInfo,
} from "../exchanges/exchange.types";
import {
  DEFAULT_UNIVERSE,
  isEligibleApexPerpetual,
  selectInitialUniverse,
  splitSymbolList,
} from "../exchanges/apex/apex.market-mapper";
import { loadApexConfig } from "../exchanges/apex/apex.config";
import { createExchangeAdapter } from "../exchanges/exchange.factory";
import { countMarkets, upsertMarkets } from "../storage/repositories/market.repository";
import {
  openResearchDatabase,
  type ResearchConnection,
} from "../storage/database";

export interface MarketSyncOptions {
  requestedSymbols?: string[];
  universeSize?: number;
}

export interface MarketSyncResult {
  exchange: string;
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

/**
 * Fetches market metadata, filters tradable USDT perpetuals and persists the
 * full snapshot. Safe to run repeatedly.
 */
export async function syncMarketMetadata(
  adapter: ExchangeAdapter,
  connection: ResearchConnection,
  options: MarketSyncOptions = {},
): Promise<MarketSyncResult> {
  const markets = await adapter.getMarkets();
  const requestedSymbols =
    options.requestedSymbols ?? splitSymbolList(process.env.APEX_SYMBOLS);
  const universeSize =
    options.universeSize ?? Number(process.env.APEX_UNIVERSE_SIZE ?? 10);

  const saved = await upsertMarkets(connection, markets);
  const counts = await countMarkets(connection, adapter.id);

  return {
    exchange: adapter.id,
    markets,
    eligible: markets.filter(isEligibleApexPerpetual),
    universe: selectInitialUniverse(markets, requestedSymbols, universeSize),
    saved,
    counts,
  };
}

export function formatMarketReport(
  result: MarketSyncResult,
  environment: string,
): string {
  const lines = [
    "=== APEX MARKET DATA REPORT ===",
    "",
    `Exchange:        ${result.exchange}`,
    `Environment:     ${environment}`,
    "Market Type:     Linear USDT Perpetual",
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
    const min = market.minAmount ?? "n/a";

    lines.push(
      `  - ${market.symbol} (${market.exchangeSymbol}) tick=${tick} step=${step} min=${min}`,
    );
  }

  if (result.universe.length === 0) {
    lines.push(`  (none; default majors: ${DEFAULT_UNIVERSE.join(", ")})`);
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const config = loadApexConfig();
  const adapter = createExchangeAdapter({ exchange: "apex" });
  const connection = await openResearchDatabase();

  await adapter.connect();

  try {
    const result = await syncMarketMetadata(adapter, connection);
    console.log(
      formatMarketReport(result, config.marketDataEnvironment),
    );
  } finally {
    await adapter.close();
  }
}
