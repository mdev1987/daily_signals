import { ExchangeConfigurationError } from "./exchange.errors";
import type { ExchangeEnvironment, MarketInfo } from "./exchange.types";
import type { TradingMode } from "./exchange.config";
import {
  DEFAULT_UNIVERSE as APEX_DEFAULT_UNIVERSE,
  isEligibleApexPerpetual,
  selectInitialUniverse as selectApexUniverse,
} from "./apex/apex.market-mapper";
import { loadApexConfig } from "./apex/apex.config";
import {
  DEFAULT_UNIVERSE as PARADEX_DEFAULT_UNIVERSE,
  isEligibleParadexPerpetual,
  selectInitialUniverse as selectParadexUniverse,
} from "./paradex/paradex.market-mapper";
import { loadParadexConfig } from "./paradex/paradex.config";

export type ExchangeId = "apex" | "paradex";

export const EXCHANGE_IDS: readonly ExchangeId[] = ["apex", "paradex"];

/**
 * How a venue pages through historical candles:
 *
 * - `backward`: the request returns the newest candles ending at the upper
 *   bound, so the backfill walks towards the past (ApeX).
 * - `forward`: the request returns candles from the lower bound upwards, so
 *   the backfill walks towards the present (Paradex).
 */
export type PaginationDirection = "backward" | "forward";

export interface ExchangeEnvNames {
  symbols: string;
  universeSize: string;
  timeframe: string;
  backfillDays: string;
  requestDelayMs: string;
}

export interface ExchangeRuntimeSummary {
  environment: ExchangeEnvironment;
  privateApiEnabled: boolean;
  privateApiEnvironment: ExchangeEnvironment;
  orderSubmissionEnabled: boolean;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
}

/**
 * Venue-specific metadata and universe rules, kept in one place so ingestion
 * and reporting code never import a concrete adapter.
 */
export interface ExchangeProfile {
  id: ExchangeId;
  /** Human label used in reports. */
  label: string;
  /** Contract type shown in reports, e.g. "Linear USDC Perpetual". */
  marketTypeLabel: string;
  eligibleSettle: string;
  eligibleQuote: string;
  defaultUniverse: readonly string[];
  pagination: PaginationDirection;
  /**
   * True when the venue omits candles for intervals without trades. Data
   * quality reports then treat gaps as expected instead of a failure.
   */
  sparseCandles: boolean;
  env: ExchangeEnvNames;
  isEligible(market: MarketInfo): boolean;
  selectUniverse(
    markets: MarketInfo[],
    requestedSymbols: string[],
    limit?: number,
  ): MarketInfo[];
  describe(env?: Record<string, string | undefined>): ExchangeRuntimeSummary;
}

const APEX_PROFILE: ExchangeProfile = {
  id: "apex",
  label: "ApeX Omni",
  marketTypeLabel: "Linear USDT Perpetual",
  eligibleSettle: "USDT",
  eligibleQuote: "USDT",
  defaultUniverse: APEX_DEFAULT_UNIVERSE,
  pagination: "backward",
  sparseCandles: false,
  env: {
    symbols: "APEX_SYMBOLS",
    universeSize: "APEX_UNIVERSE_SIZE",
    timeframe: "APEX_TIMEFRAME",
    backfillDays: "APEX_BACKFILL_DAYS",
    requestDelayMs: "APEX_REQUEST_DELAY_MS",
  },
  isEligible: isEligibleApexPerpetual,
  selectUniverse: selectApexUniverse,
  describe(env = process.env) {
    const config = loadApexConfig(env);
    return {
      environment: config.marketDataEnvironment,
      privateApiEnabled: config.privateApiEnabled,
      privateApiEnvironment: config.privateApiEnvironment,
      orderSubmissionEnabled: config.orderSubmissionEnabled,
      tradingMode: config.tradingMode,
      liveTradingEnabled: config.liveTradingEnabled,
    };
  },
};

const PARADEX_PROFILE: ExchangeProfile = {
  id: "paradex",
  label: "Paradex",
  marketTypeLabel: "Linear USDC Perpetual",
  eligibleSettle: "USDC",
  eligibleQuote: "USD",
  defaultUniverse: PARADEX_DEFAULT_UNIVERSE,
  pagination: "forward",
  // Paradex klines only include intervals that traded, so gaps are expected.
  sparseCandles: true,
  env: {
    symbols: "PARADEX_SYMBOLS",
    universeSize: "PARADEX_UNIVERSE_SIZE",
    timeframe: "PARADEX_TIMEFRAME",
    backfillDays: "PARADEX_BACKFILL_DAYS",
    requestDelayMs: "PARADEX_REQUEST_DELAY_MS",
  },
  isEligible: isEligibleParadexPerpetual,
  selectUniverse: selectParadexUniverse,
  describe(env = process.env) {
    const config = loadParadexConfig(env);
    return {
      environment: config.marketDataEnvironment,
      privateApiEnabled: config.privateApiEnabled,
      privateApiEnvironment: config.privateApiEnvironment,
      orderSubmissionEnabled: config.orderSubmissionEnabled,
      tradingMode: config.tradingMode,
      liveTradingEnabled: config.liveTradingEnabled,
    };
  },
};

const PROFILES: Record<ExchangeId, ExchangeProfile> = {
  apex: APEX_PROFILE,
  paradex: PARADEX_PROFILE,
};

export function normalizeExchangeId(value?: string): ExchangeId {
  const normalized = (value ?? process.env.EXCHANGE ?? "apex")
    .trim()
    .toLowerCase();

  if (normalized === "apex" || normalized === "paradex") return normalized;

  throw new ExchangeConfigurationError(
    `Unsupported exchange "${value ?? process.env.EXCHANGE ?? ""}". ` +
      `Available adapters: ${EXCHANGE_IDS.join(", ")}`,
  );
}

export function resolveExchangeProfile(value?: string): ExchangeProfile {
  return PROFILES[normalizeExchangeId(value)];
}
