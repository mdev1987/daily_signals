import { ExchangeConfigurationError } from "../exchange.errors";
import type { ExchangeEnvironment } from "../exchange.types";
import {
  readBoolean,
  readExchangeEnvironment,
  readTradingMode,
  type TradingMode,
} from "../exchange.config";

export type { TradingMode };

/**
 * Paradex accepts two credential shapes:
 *
 * - `starknet`: the Paradex account keypair shown in the UI (private key,
 *   public key, account address). This is the read/trade path used by CCXT.
 * - `evm`: an Ethereum wallet key plus its address, from which Paradex derives
 *   the StarkNet account. Only needed during onboarding/derivation.
 */
export type ParadexAuthMode = "starknet" | "evm";

/**
 * How a StarkNet keypair authenticates.
 *
 * - `auto`: try the account endpoint, then the subkey endpoint.
 * - `account`: the key is the account's main key.
 * - `subkey`: the key is a registered subkey, which must sign in at
 *   `/v1/auth/{public_key}`.
 */
export type ParadexAuthStrategy = "auto" | "account" | "subkey";

export interface ParadexCredentials {
  /** EVM wallet address (0x + 40 hex), optional. */
  walletAddress: string;
  /** EVM wallet private key, optional. */
  evmPrivateKey: string;
  /** Paradex/StarkNet account private key. */
  paradexPrivateKey: string;
  /** Paradex/StarkNet account public key. */
  paradexPublicKey: string;
  /** Paradex account address (StarkNet contract account). */
  paradexAddress: string;
}

export interface ParadexConfig {
  /** Environment used for public market data (prices, candles, order books). */
  marketDataEnvironment: ExchangeEnvironment;
  /** Private account reads are opt-in. */
  privateApiEnabled: boolean;
  privateApiEnvironment: ExchangeEnvironment;
  /**
   * Hard code-level gate for order placement. It must remain false until
   * authenticated reads, testnet paper execution and risk controls have been
   * verified end to end.
   */
  orderSubmissionEnabled: boolean;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
  /** Endpoint a StarkNet keypair authenticates at. */
  authStrategy: ParadexAuthStrategy;
  credentials: ParadexCredentials;
}

function readAuthStrategy(value: string | undefined): ParadexAuthStrategy {
  switch (value?.trim().toLowerCase()) {
    case "account":
    case "main":
    case "mainkey":
      return "account";
    case "subkey":
    case "sub":
      return "subkey";
    case "auto":
    case undefined:
    case "":
      return "auto";
    default:
      throw new ExchangeConfigurationError(
        `PARADEX_AUTH_MODE must be auto, account or subkey; received "${value}"`,
      );
  }
}

export function loadParadexConfig(
  env: Record<string, string | undefined> = process.env,
): ParadexConfig {
  // PARADEX_ENV is the legacy single-environment switch.
  const legacyEnvironment = env.PARADEX_ENV?.trim();

  return {
    // The guide's initial environment is testnet, so an empty config can never
    // point market data at production by accident.
    marketDataEnvironment: readExchangeEnvironment(
      env.PARADEX_MARKET_DATA_ENV ?? legacyEnvironment,
      "testnet",
      "PARADEX_MARKET_DATA_ENV",
    ),
    privateApiEnabled: readBoolean(env.PARADEX_PRIVATE_API_ENABLED, false),
    privateApiEnvironment: readExchangeEnvironment(
      env.PARADEX_PRIVATE_API_ENV ?? legacyEnvironment,
      "testnet",
      "PARADEX_PRIVATE_API_ENV",
    ),
    orderSubmissionEnabled: readBoolean(
      env.PARADEX_ORDER_SUBMISSION_ENABLED,
      false,
    ),
    tradingMode: readTradingMode(env.TRADING_MODE),
    liveTradingEnabled: readBoolean(env.LIVE_TRADING_ENABLED, false),
    authStrategy: readAuthStrategy(env.PARADEX_AUTH_MODE),
    credentials: {
      walletAddress: (
        env.PARADEX_WALLET_ADDRESS ??
        env.PARADEX_EVM_ADDRESS ??
        ""
      ).trim(),
      evmPrivateKey: (
        env.PARADEX_EVM_PRIVATE_KEY ??
        env.PARADEX_ETH_PRIVATE_KEY ??
        ""
      ).trim(),
      // `PARADEX_PRIVATE_KEY` and `PARADEX_PUBLICK_KEY` are the names already
      // present in the local `.env` (the latter keeps its historical typo).
      paradexPrivateKey: (
        env.PARADEX_PARADEX_PRIVATE_KEY ??
        env.PARADEX_PRIVATE_KEY ??
        ""
      ).trim(),
      paradexPublicKey: (
        env.PARADEX_PARADEX_PUBLIC_KEY ??
        env.PARADEX_PUBLIC_KEY ??
        env.PARADEX_PUBLICK_KEY ??
        ""
      ).trim(),
      paradexAddress: (
        env.PARADEX_PARADEX_ADDRESS ??
        env.PARADEX_ADDRESS ??
        ""
      ).trim(),
    },
  };
}

export function hasParadexStarknetCredentials(
  config: ParadexConfig,
): boolean {
  const { paradexPrivateKey, paradexPublicKey, paradexAddress } =
    config.credentials;
  return Boolean(paradexPrivateKey && paradexPublicKey && paradexAddress);
}

export function hasParadexEvmCredentials(config: ParadexConfig): boolean {
  const { walletAddress, evmPrivateKey } = config.credentials;
  return Boolean(walletAddress && evmPrivateKey);
}

export function getParadexAuthMode(
  config: ParadexConfig,
): ParadexAuthMode | null {
  if (hasParadexStarknetCredentials(config)) return "starknet";
  if (hasParadexEvmCredentials(config)) return "evm";
  return null;
}

/**
 * Order placement stays blocked unless all independent switches agree and a
 * usable signing identity exists. A stale `.env` cannot enable trading alone.
 */
export function assertParadexOrderSubmissionAllowed(
  config: ParadexConfig,
): void {
  if (!config.orderSubmissionEnabled) {
    throw new ExchangeConfigurationError(
      "Order submission is disabled (PARADEX_ORDER_SUBMISSION_ENABLED=false)",
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

  if (getParadexAuthMode(config) === null) {
    throw new ExchangeConfigurationError(
      "Order submission requires Paradex account credentials " +
        "(PARADEX_PRIVATE_KEY/PARADEX_PUBLICK_KEY/PARADEX_ADDRESS) or an EVM " +
        "wallet (PARADEX_WALLET_ADDRESS/PARADEX_EVM_PRIVATE_KEY)",
    );
  }
}

/** Configuration summary with secrets removed. */
export function describeParadexConfig(config: ParadexConfig) {
  return {
    marketDataEnvironment: config.marketDataEnvironment,
    privateApiEnabled: config.privateApiEnabled,
    privateApiEnvironment: config.privateApiEnvironment,
    orderSubmissionEnabled: config.orderSubmissionEnabled,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
    authMode: getParadexAuthMode(config),
    authStrategy: config.authStrategy,
    credentialsPresent: getParadexAuthMode(config) !== null,
  };
}
