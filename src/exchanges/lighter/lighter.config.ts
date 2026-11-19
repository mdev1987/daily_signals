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

export type LighterMarginMode = "cross" | "isolated";

/**
 * Futures execution settings. The paper-trading engine remains the source of
 * truth; this config only controls whether its positions are mirrored onto a
 * Lighter account and with which margin.
 */
export interface LighterExecutionConfig {
  /** Mirror paper positions to Lighter. Requires every order gate plus this. */
  enabled: boolean;
  /** Account-wide leverage per market, e.g. 5 for 5x. */
  leverage: number;
  marginMode: LighterMarginMode;
  /**
   * Optional restriction on which venue markets may be mirrored. `null` means
   * every perpetual the execution deployment lists; symbols are resolved from
   * the venue's own market list rather than a hardcoded universe.
   */
  symbols: readonly string[] | null;
  /** Extra tolerance over the best price when signing a market order. */
  worstPriceSlippagePct: number;
  /** Testnet is the default; mainnet needs an explicit opt-in. */
  allowMainnetExecution: boolean;
  /** How often venue positions are reconciled against paper positions. */
  reconcileIntervalMs: number;
  /**
   * Multiplies the paper quantity before it is sent to the venue. The paper
   * book is small (default $1,000 at 2% per trade = $20), which can fall
   * below the venue's minimum order size. 1 mirrors the paper size exactly.
   */
  sizeMultiplier: number;
  /**
   * Hard cap on a single entry notional in USD. 0 disables the cap. The size
   * multiplier must not be able to turn a small paper trade into an unbounded
   * venue position.
   */
  maxNotionalUsd: number;
  /**
   * Close every bot-owned position when the process shuts down cleanly. There
   * is no venue-side stop loss yet, so leaving a position open on SIGTERM
   * would leave it unprotected. SIGKILL cannot run this policy.
   */
  flattenOnShutdown: boolean;
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
  /**
   * REST base URL per environment.
   *
   * Lighter runs more than one deployment. The web app at
   * `testnet.app.lighter.xyz` talks to `api.testnet.lighter.xyz`, while the
   * docs reference API is `testnet.zklighter.elliot.ai`. Accounts, balances
   * and API keys do not carry over between them, so the host must match the
   * one the key was created on.
   */
  baseUrls: Record<ExchangeEnvironment, string>;
  /** Leverage and mirroring of paper positions onto the account. */
  execution: LighterExecutionConfig;
}

/** Lighter's own web and mobile clients reserve these API key indexes. */
const RESERVED_API_KEY_INDEXES = new Set([0, 1, 2, 3]);

const DEFAULT_LIBRARY_PATH = ".cache/lighter/lighter.wasm";
const DEFAULT_WASM_EXEC_PATH = ".cache/lighter/wasm_exec.js";

/**
 * The testnet default follows the web app, because that is where users create
 * accounts and API keys. The docs reference deployment is still reachable and
 * can be selected with `LIGHTER_TESTNET_BASE_URL`.
 */
export const DEFAULT_BASE_URLS: Record<ExchangeEnvironment, string> = {
  mainnet: "https://mainnet.zklighter.elliot.ai",
  testnet: "https://api.testnet.lighter.xyz",
};

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

/**
 * Signed requests carry an auth token, so the base URL must be HTTPS. A plain
 * HTTP override is rejected instead of silently sending a token in clear text.
 */
function readBaseUrl(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ExchangeConfigurationError(
      `${name} must be an absolute URL, received "${normalized}"`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new ExchangeConfigurationError(
      `${name} must use https, received "${normalized}"`,
    );
  }

  return normalized.replace(/\/+$/, "");
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

function readDecimal(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ExchangeConfigurationError(
      `${name} must be a finite number, received "${normalized}"`,
    );
  }

  return parsed;
}

function readMarginMode(value: string | undefined): LighterMarginMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "cross";
  if (normalized === "cross" || normalized === "isolated") return normalized;

  throw new ExchangeConfigurationError(
    `LIGHTER_MARGIN_MODE must be "cross" or "isolated", received "${value}"`,
  );
}

/**
 * `LIGHTER_EXECUTION_SYMBOLS` is an optional restriction, not the universe.
 * Lighter lists crypto, FX, metals, equities and indices, so the default is to
 * mirror every perpetual the execution deployment offers. Leaving the variable
 * empty (or `*`/`all`) keeps that behaviour; listing symbols narrows it.
 */
function readExecutionSymbols(value: string | undefined): string[] | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized === "*" || normalized.toLowerCase() === "all") return null;

  const symbols = normalized
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);

  if (symbols.length === 0) return null;

  for (const symbol of symbols) {
    if (!/^[A-Z0-9]+$/.test(symbol)) {
      throw new ExchangeConfigurationError(
        `LIGHTER_EXECUTION_SYMBOLS contains an invalid symbol "${symbol}"`,
      );
    }
  }

  return [...new Set(symbols)];
}

function readExecutionConfig(
  env: Record<string, string | undefined>,
): LighterExecutionConfig {
  const leverage = readDecimal(env.LIGHTER_LEVERAGE, 5, "LIGHTER_LEVERAGE");
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 50) {
    throw new ExchangeConfigurationError(
      `LIGHTER_LEVERAGE must be an integer between 1 and 50, received "${leverage}"`,
    );
  }

  const worstPriceSlippagePct = readDecimal(
    env.LIGHTER_WORST_PRICE_SLIPPAGE_PCT,
    1,
    "LIGHTER_WORST_PRICE_SLIPPAGE_PCT",
  );
  if (worstPriceSlippagePct < 0 || worstPriceSlippagePct > 10) {
    throw new ExchangeConfigurationError(
      "LIGHTER_WORST_PRICE_SLIPPAGE_PCT must be between 0 and 10",
    );
  }

  const reconcileIntervalMs = readDecimal(
    env.LIGHTER_RECONCILE_INTERVAL_MS,
    60_000,
    "LIGHTER_RECONCILE_INTERVAL_MS",
  );
  if (reconcileIntervalMs < 5_000) {
    throw new ExchangeConfigurationError(
      "LIGHTER_RECONCILE_INTERVAL_MS must be at least 5000",
    );
  }

  const sizeMultiplier = readDecimal(
    env.LIGHTER_SIZE_MULTIPLIER,
    1,
    "LIGHTER_SIZE_MULTIPLIER",
  );
  if (!(sizeMultiplier > 0) || sizeMultiplier > 1_000) {
    throw new ExchangeConfigurationError(
      "LIGHTER_SIZE_MULTIPLIER must be greater than 0 and at most 1000",
    );
  }

  const maxNotionalUsd = readDecimal(
    env.LIGHTER_MAX_NOTIONAL_USD,
    0,
    "LIGHTER_MAX_NOTIONAL_USD",
  );
  if (!(maxNotionalUsd >= 0) || !Number.isFinite(maxNotionalUsd)) {
    throw new ExchangeConfigurationError(
      "LIGHTER_MAX_NOTIONAL_USD must be zero or a positive number",
    );
  }

  // Scaling the paper size is only meant to clear a venue minimum. Without a
  // cap that multiplier could open a position far larger than the $20 paper
  // trade it mirrors, so the combination is refused rather than defaulted.
  if (sizeMultiplier > 1 && maxNotionalUsd === 0) {
    throw new ExchangeConfigurationError(
      "LIGHTER_MAX_NOTIONAL_USD must be set when LIGHTER_SIZE_MULTIPLIER > 1",
    );
  }

  return {
    enabled: readBoolean(env.LIGHTER_EXECUTION_ENABLED, false),
    leverage,
    marginMode: readMarginMode(env.LIGHTER_MARGIN_MODE),
    symbols: readExecutionSymbols(env.LIGHTER_EXECUTION_SYMBOLS),
    worstPriceSlippagePct,
    allowMainnetExecution: readBoolean(
      env.LIGHTER_ALLOW_MAINNET_EXECUTION,
      false,
    ),
    reconcileIntervalMs,
    sizeMultiplier,
    maxNotionalUsd,
    flattenOnShutdown: readBoolean(env.LIGHTER_FLATTEN_ON_SHUTDOWN, true),
  };
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
    baseUrls: {
      mainnet: readBaseUrl(
        env.LIGHTER_MAINNET_BASE_URL,
        DEFAULT_BASE_URLS.mainnet,
        "LIGHTER_MAINNET_BASE_URL",
      ),
      testnet: readBaseUrl(
        env.LIGHTER_TESTNET_BASE_URL,
        DEFAULT_BASE_URLS.testnet,
        "LIGHTER_TESTNET_BASE_URL",
      ),
    },
    execution: readExecutionConfig(env),
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

/**
 * Extra gate for mirroring paper positions onto the venue. It reuses every
 * order-submission check and then enforces the execution-specific guards. The
 * default environment is testnet; a mainnet run needs a deliberate opt-in.
 */
export function assertLighterExecutionAllowed(config: LighterConfig): void {
  if (!config.execution.enabled) {
    throw new ExchangeConfigurationError(
      "Lighter execution is disabled (LIGHTER_EXECUTION_ENABLED=false)",
    );
  }

  assertLighterOrderSubmissionAllowed(config);

  if (!config.privateApiEnabled) {
    throw new ExchangeConfigurationError(
      "Lighter execution requires LIGHTER_PRIVATE_API_ENABLED=true",
    );
  }

  if (
    config.privateApiEnvironment !== "testnet" &&
    !config.execution.allowMainnetExecution
  ) {
    throw new ExchangeConfigurationError(
      "Lighter execution is restricted to testnet. Set " +
        "LIGHTER_ALLOW_MAINNET_EXECUTION=true to trade a funded mainnet account.",
    );
  }

  if (
    config.execution.symbols !== null &&
    config.execution.symbols.length === 0
  ) {
    throw new ExchangeConfigurationError(
      "LIGHTER_EXECUTION_SYMBOLS must be empty (all venue markets) or list symbols",
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
    baseUrls: config.baseUrls,
    libraryPath: config.libraryPath,
    wasmExecPath: config.wasmExecPath,
    execution: config.execution,
  };
}

/**
 * Fraction of the entry price the market can move against a leveraged position
 * before the venue liquidates it, with a safety haircut for maintenance margin
 * and fees. At 5x the raw distance is 20%; at 50x it is only 2%.
 */
export function liquidationDistancePct(leverage: number): number {
  return (100 / leverage) * 0.8;
}

/**
 * The paper engine's stop loss only exists in the simulation (it is evaluated
 * on closed 5m candles). If the venue would liquidate the position before that
 * stop level, the mirror can lose the whole margin while paper shows a small
 * stop-out. Refuse that combination instead of trading it.
 */
export function assertStopBeforeLiquidation(
  config: LighterConfig,
  stopLossPct: number,
): void {
  const distance = liquidationDistancePct(config.execution.leverage);

  // Require a 2x buffer: candle-close stops can overshoot the stop level.
  if (stopLossPct * 2 > distance) {
    throw new ExchangeConfigurationError(
      `LIGHTER_LEVERAGE=${config.execution.leverage}x puts liquidation about ` +
        `${distance.toFixed(1)}% from entry, too close to the ${stopLossPct}% ` +
        `paper stop loss (needs at least 2x headroom). Lower the leverage or ` +
        `the stop loss.`,
    );
  }
}
