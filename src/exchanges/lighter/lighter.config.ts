import { resolve } from "node:path";
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
 * Lighter credentials are an API key pair plus two integer indexes, not an
 * address/keypair like Paradex.
 *
 * - `accountIndex` identifies the account (master or sub-account).
 * - `apiKeyIndex` identifies which key of that account signs. Lighter reserves
 *   0-3 for its own web/mobile clients, so automation uses 4-254.
 */
export interface LighterCredentials {
  /** API private key (40 bytes hex). Never logged. */
  apiKey: string;
  /** Matching API public key. Informational; the venue verifies the signature. */
  publicKey: string;
  accountIndex: number | null;
  apiKeyIndex: number | null;
}

export interface LighterConfig {
  /** Environment used for public market data (prices, candles, order books). */
  marketDataEnvironment: ExchangeEnvironment;
  /** Private account reads are opt-in. */
  privateApiEnabled: boolean;
  privateApiEnvironment: ExchangeEnvironment;
  /**
   * Hard code-level gate for order placement. It must remain false until the
   * testnet order lifecycle, paper execution and risk controls pass end to end.
   */
  orderSubmissionEnabled: boolean;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
  credentials: LighterCredentials;
  /**
   * Absolute paths to the CCXT signing runtime. The wasm binary is not
   * committed; `bun run lighter:setup` downloads it into the gitignored cache.
   */
  libraryPath: string;
  wasmExecPath: string;
  /** Chain id the signer uses. 304 mainnet, 300 testnet. */
  chainId: number;
}

/** Lighter's own web and mobile clients reserve these API key indexes. */
const RESERVED_API_KEY_INDEXES = new Set([0, 1, 2, 3]);

const DEFAULT_LIBRARY_PATH = ".cache/lighter/lighter.wasm";
const DEFAULT_WASM_EXEC_PATH = ".cache/lighter/wasm_exec.js";

function chainIdFor(environment: ExchangeEnvironment): number {
  return environment === "mainnet" ? 304 : 300;
}

function readInteger(
  value: string | undefined,
  name: string,
): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  if (!/^\d+$/.test(normalized)) {
    throw new ExchangeConfigurationError(
      `${name} must be a non-negative integer, received "${normalized}"`,
    );
  }

  return Number(normalized);
}

function readCredentials(
  env: Record<string, string | undefined>,
): LighterCredentials {
  const apiKey = (
    env.LIGHTER_API_KEY ??
    env.LIGHTER_PRIVATE_KEY ??
    env.LIGHTHER_PRIVATE_KEY ??
    ""
  ).trim();

  // `LIGHTHER_*` is the spelling that briefly existed in the local `.env`.
  const publicKey = (
    env.LIGHTER_PUBLIC_KEY ??
    env.LIGHTER_PUBLICK_KEY ??
    env.LIGHTHER_PUBLIC_KEY ??
    env.LIGHTHER_PUBLICK_KEY ??
    ""
  ).trim();

  const accountIndex = readInteger(
    env.LIGHTER_ACCOUNT_INDEX,
    "LIGHTER_ACCOUNT_INDEX",
  );
  const apiKeyIndex = readInteger(env.LIGHTER_API_KEY_INDEX ?? env.LIGHTER_KEY_INDEX, "LIGHTER_KEY_INDEX");

  if (apiKeyIndex !== null && RESERVED_API_KEY_INDEXES.has(apiKeyIndex)) {
    throw new ExchangeConfigurationError(
      `LIGHTER_KEY_INDEX ${apiKeyIndex} is reserved for Lighter's own clients; ` +
        "use an index between 4 and 254",
    );
  }

  if (apiKeyIndex !== null && apiKeyIndex > 254) {
    throw new ExchangeConfigurationError(
      `LIGHTER_KEY_INDEX must be between 4 and 254, received ${apiKeyIndex}`,
    );
  }

  return { apiKey, publicKey, accountIndex, apiKeyIndex };
}

export function loadLighterConfig(
  env: Record<string, string | undefined> = process.env,
): LighterConfig {
  const marketDataEnvironment = readExchangeEnvironment(
    env.LIGHTER_MARKET_DATA_ENV ?? env.LIGHTER_ENV,
    "testnet",
    "LIGHTER_MARKET_DATA_ENV",
  );
  const privateApiEnvironment = readExchangeEnvironment(
    env.LIGHTER_PRIVATE_API_ENV ?? env.LIGHTER_ENV,
    "testnet",
    "LIGHTER_PRIVATE_API_ENV",
  );

  return {
    marketDataEnvironment,
    privateApiEnabled: readBoolean(env.LIGHTER_PRIVATE_API_ENABLED, false),
    privateApiEnvironment,
    orderSubmissionEnabled: readBoolean(
      env.LIGHTER_ORDER_SUBMISSION_ENABLED,
      false,
    ),
    tradingMode: readTradingMode(env.TRADING_MODE),
    liveTradingEnabled: readBoolean(env.LIVE_TRADING_ENABLED, false),
    credentials: readCredentials(env),
    libraryPath: resolve(env.LIGHTER_LIBRARY_PATH ?? DEFAULT_LIBRARY_PATH),
    wasmExecPath: resolve(env.LIGHTER_WASM_EXEC_PATH ?? DEFAULT_WASM_EXEC_PATH),
    chainId: readInteger(env.LIGHTER_CHAIN_ID, "LIGHTER_CHAIN_ID") ?? chainIdFor(privateApiEnvironment),
  };
}

export function hasLighterCredentials(config: LighterConfig): boolean {
  const { apiKey, accountIndex, apiKeyIndex } = config.credentials;
  return Boolean(apiKey) && accountIndex !== null && apiKeyIndex !== null;
}

/**
 * Order placement stays blocked unless every independent switch agrees and a
 * usable signing identity exists. A stale `.env` cannot enable trading alone.
 */
export function assertLighterOrderSubmissionAllowed(
  config: LighterConfig,
): void {
  if (!config.orderSubmissionEnabled) {
    throw new ExchangeConfigurationError(
      "Order submission is disabled (LIGHTER_ORDER_SUBMISSION_ENABLED=false)",
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

  if (!hasLighterCredentials(config)) {
    throw new ExchangeConfigurationError(
      "Order submission requires LIGHTER_PRIVATE_KEY, LIGHTER_ACCOUNT_INDEX " +
        "and LIGHTER_KEY_INDEX",
    );
  }
}

/** Configuration summary with secrets removed. */
export function describeLighterConfig(config: LighterConfig) {
  const { accountIndex, apiKeyIndex, apiKey, publicKey } = config.credentials;

  return {
    marketDataEnvironment: config.marketDataEnvironment,
    privateApiEnabled: config.privateApiEnabled,
    privateApiEnvironment: config.privateApiEnvironment,
    orderSubmissionEnabled: config.orderSubmissionEnabled,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
    credentialsPresent: hasLighterCredentials(config),
    apiKeyConfigured: apiKey.length > 0,
    publicKeyConfigured: publicKey.length > 0,
    accountIndex,
    apiKeyIndex,
    chainId: config.chainId,
    libraryPath: config.libraryPath,
    wasmExecPath: config.wasmExecPath,
  };
}
