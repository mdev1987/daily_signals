import ccxt, { type paradex as ParadexExchange } from "ccxt";
import { ExchangeConfigurationError } from "../exchange.errors";
import {
  getParadexAuthMode,
  hasParadexEvmCredentials,
  hasParadexStarknetCredentials,
  type ParadexConfig,
} from "./paradex.config";

export type ParadexClient = ParadexExchange;

const MARKET_LOAD_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Loads only perpetual markets.
 *
 * The unfiltered `/markets` payload includes every option series (~16 MB) and
 * regularly exceeds the request timeout. The filtered endpoint is ~65 KB but
 * can still be slow, so it is retried with backoff. `reload=true` is required
 * on every attempt because CCXT caches a rejected `loadMarkets` promise.
 */
export async function loadParadexPerpetualMarkets(
  client: ParadexClient,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MARKET_LOAD_ATTEMPTS; attempt++) {
    try {
      await client.loadMarkets(true, { asset_kind: "PERP" });
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

function baseOptions() {
  return {
    enableRateLimit: true,
    timeout: 20_000,
    adjustForTimeDifference: true,
    options: {
      defaultType: "swap" as const,
    },
  };
}

/**
 * Public client for market data. Credentials are deliberately omitted so a
 * market-data run can never perform a private request.
 */
export function createParadexPublicClient(
  config: ParadexConfig,
): ParadexClient {
  const client = new ccxt.paradex(baseOptions());

  if (config.marketDataEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}

/**
 * Authenticated client for account reads. Requires an explicit opt-in.
 * Order placement is still blocked by the adapter's own gate.
 */
export function createParadexPrivateClient(
  config: ParadexConfig,
): ParadexClient {
  if (!config.privateApiEnabled) {
    throw new ExchangeConfigurationError(
      "Private Paradex API is disabled (PARADEX_PRIVATE_API_ENABLED=false)",
    );
  }

  const authMode = getParadexAuthMode(config);

  if (authMode === null) {
    throw new ExchangeConfigurationError(
      "Private Paradex API requires either PARADEX_PRIVATE_KEY," +
        " PARADEX_PUBLICK_KEY and PARADEX_ADDRESS, or PARADEX_WALLET_ADDRESS" +
        " and PARADEX_EVM_PRIVATE_KEY",
    );
  }

  const options = { ...baseOptions().options };
  const credentials: {
    privateKey?: string;
    walletAddress?: string;
  } = {};

  if (hasParadexStarknetCredentials(config)) {
    const { paradexPrivateKey, paradexPublicKey, paradexAddress } =
      config.credentials;
    (options as Record<string, unknown>).paradexAccount = {
      privateKey: paradexPrivateKey,
      publicKey: paradexPublicKey,
      address: paradexAddress,
    };
  } else if (hasParadexEvmCredentials(config)) {
    credentials.privateKey = config.credentials.evmPrivateKey;
    credentials.walletAddress = config.credentials.walletAddress;
  }

  const client = new ccxt.paradex({
    ...baseOptions(),
    ...credentials,
    options,
  });

  if (config.privateApiEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}
