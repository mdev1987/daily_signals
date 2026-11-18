import ccxt, { type lighter as LighterExchange } from "ccxt";
import { ExchangeConfigurationError } from "../exchange.errors";
import { redactMessage } from "../normalizers";
import {
  hasLighterCredentials,
  type LighterConfig,
} from "./lighter.config";

export type LighterClient = LighterExchange;

/** Raw endpoints CCXT exposes but does not model as first-class methods. */
export interface LighterRawApi {
  publicGetFundings(params: Record<string, unknown>): Promise<{
    fundings?: unknown[];
  }>;
  privateGetAccountActiveOrders(params: Record<string, unknown>): Promise<{
    orders?: unknown[];
  }>;
  preLoadLighterLibrary(params?: Record<string, unknown>): Promise<boolean>;
}

const MARKET_LOAD_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseOptions() {
  return {
    enableRateLimit: true,
    timeout: 30_000,
    adjustForTimeDifference: true,
    options: {
      defaultType: "swap" as const,
    },
  };
}

/** Loads the market list with backoff; CCXT caches a rejected load promise. */
export async function loadLighterMarkets(
  client: LighterClient,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MARKET_LOAD_ATTEMPTS; attempt++) {
    try {
      await client.loadMarkets(true);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MARKET_LOAD_ATTEMPTS - 1) {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

/**
 * Public client for market data. Credentials are deliberately omitted so a
 * market-data run can never perform a signed request.
 */
export function createLighterPublicClient(
  config: LighterConfig,
): LighterClient {
  const client = new ccxt.lighter(baseOptions());

  if (config.marketDataEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}

/**
 * Client for account reads and order signing. CCXT signs every private request
 * with the wasm signer, so the API key and both indexes are attached to the
 * client options once. Requires an explicit opt-in.
 */
export function createLighterPrivateClient(
  config: LighterConfig,
): LighterClient {
  if (!config.privateApiEnabled) {
    throw new ExchangeConfigurationError(
      "Private Lighter API is disabled (LIGHTER_PRIVATE_API_ENABLED=false)",
    );
  }

  if (!hasLighterCredentials(config)) {
    throw new ExchangeConfigurationError(
      "Private Lighter API requires LIGHTER_PRIVATE_KEY, LIGHTER_ACCOUNT_INDEX " +
        "and LIGHTER_KEY_INDEX",
    );
  }

  const { apiKey, accountIndex, apiKeyIndex } = config.credentials;
  const account = String(accountIndex);
  const key = String(apiKeyIndex);

  const client = new ccxt.lighter({
    ...baseOptions(),
    options: {
      ...baseOptions().options,
      accountIndex,
      apiKeyIndex,
      chainId: config.chainId,
      libraryPath: config.libraryPath,
      wasmExecPath: config.wasmExecPath,
      auths: {
        [account]: {
          [key]: { lighterPrivateKey: apiKey },
        },
      },
    },
  });

  if (config.privateApiEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}

/**
 * Loads the wasm signer that CCXT uses to mint auth tokens. Called before the
 * first signed request so a missing binary fails with a setup instruction
 * instead of a stack trace from the signer.
 */
export async function ensureLighterSigner(
  client: LighterClient,
  config: LighterConfig,
): Promise<void> {
  const api = client as unknown as LighterRawApi;

  try {
    const loaded = await api.preLoadLighterLibrary();
    if (!loaded) {
      throw new Error("the signer did not report a loaded account");
    }
  } catch (error) {
    const message = redactMessage(
      error instanceof Error ? error.message : String(error),
      [config.credentials.apiKey],
    );

    throw new ExchangeConfigurationError(
      "Lighter signer is unavailable. Run `bun run lighter:setup` to download " +
        `the wasm signer into ${config.libraryPath}, then retry. (${message})`,
    );
  }
}
