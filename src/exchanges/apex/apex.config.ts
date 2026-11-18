import { ExchangeConfigurationError } from "../exchange.errors";
import type { ExchangeEnvironment } from "../exchange.types";
import {
  readBoolean,
  readExchangeEnvironment,
  readTradingMode,
  type TradingMode,
} from "../exchange.config";

export type { TradingMode };

export interface ApexCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  /** Omni/ZK signing material. Required for order placement, not for reads. */
  seeds: string;
}

export interface ApexConfig {
  /** Environment used for public market data (prices, candles, order books). */
  marketDataEnvironment: ExchangeEnvironment;
  /**
   * Private account reads are opt-in. Market data never needs credentials and
   * therefore never needs this flag.
   */
  privateApiEnabled: boolean;
  privateApiEnvironment: ExchangeEnvironment;
  /**
   * Hard code-level gate for order placement. It must remain false until the
   * Testnet order lifecycle has been verified end to end.
   */
  orderSubmissionEnabled: boolean;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
  credentials: ApexCredentials;
}

export function loadApexConfig(
  env: Record<string, string | undefined> = process.env,
): ApexConfig {
  // APEX_ENV is the legacy single-environment switch kept for compatibility.
  const legacyEnvironment = env.APEX_ENV?.trim();

  const marketDataEnvironment = readExchangeEnvironment(
    env.APEX_MARKET_DATA_ENV ?? legacyEnvironment,
    "mainnet",
    "APEX_MARKET_DATA_ENV",
  );
  const privateApiEnvironment = readExchangeEnvironment(
    env.APEX_PRIVATE_API_ENV ?? legacyEnvironment,
    "mainnet",
    "APEX_PRIVATE_API_ENV",
  );

  return {
    marketDataEnvironment,
    privateApiEnabled: readBoolean(env.APEX_PRIVATE_API_ENABLED, false),
    privateApiEnvironment,
    orderSubmissionEnabled: readBoolean(
      env.APEX_ORDER_SUBMISSION_ENABLED,
      false,
    ),
    tradingMode: readTradingMode(env.TRADING_MODE),
    liveTradingEnabled: readBoolean(env.LIVE_TRADING_ENABLED, false),
    credentials: {
      apiKey: (env.OMNIAPEX_API_KEY ?? env.APEX_API_KEY ?? "").trim(),
      secret: (env.OMNIAPEX_API_SECRET ?? env.APEX_API_SECRET ?? "").trim(),
      passphrase: (
        env.OMNIAPEX_PASS_PHRASE ??
        env.APEX_API_PASSPHRASE ??
        ""
      ).trim(),
      seeds: (env.APEX_OMNI_SEEDS ?? env.OMNI_SEEDS ?? "").trim(),
    },
  };
}

export function hasApexCredentials(config: ApexConfig): boolean {
  const { apiKey, secret, passphrase } = config.credentials;
  return Boolean(apiKey && secret && passphrase);
}

/**
 * Order placement stays blocked unless all three independent switches agree.
 * A stale `.env` therefore cannot enable trading on its own.
 */
export function assertOrderSubmissionAllowed(config: ApexConfig): void {
  if (!config.orderSubmissionEnabled) {
    throw new ExchangeConfigurationError(
      "Order submission is disabled (APEX_ORDER_SUBMISSION_ENABLED=false)",
    );
  }

  if (config.tradingMode !== "live") {
    throw new ExchangeConfigurationError(
      "Order submission requires TRADING_MODE=live",
    );
  }

  if (!config.liveTradingEnabled) {
    throw new ExchangeConfigurationError(
      "Order submission requires LIVE_TRADING_ENABLED=true",
    );
  }

  if (!config.credentials.seeds) {
    throw new ExchangeConfigurationError(
      "Order submission requires APEX_OMNI_SEEDS (Omni/ZK signing material)",
    );
  }
}

/** Configuration summary with secrets removed. */
export function describeApexConfig(config: ApexConfig) {
  return {
    marketDataEnvironment: config.marketDataEnvironment,
    privateApiEnabled: config.privateApiEnabled,
    privateApiEnvironment: config.privateApiEnvironment,
    orderSubmissionEnabled: config.orderSubmissionEnabled,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
    credentialsPresent: hasApexCredentials(config),
    seedsPresent: Boolean(config.credentials.seeds),
  };
}
