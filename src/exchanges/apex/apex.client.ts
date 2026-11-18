import ccxt, { type apex as ApexExchange } from "ccxt";
import { ExchangeConfigurationError } from "../exchange.errors";
import {
  hasApexCredentials,
  type ApexConfig,
} from "./apex.config";

export type ApexClient = ApexExchange;

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
export function createApexPublicClient(config: ApexConfig): ApexClient {
  const client = new ccxt.apex(baseOptions());

  if (config.marketDataEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}

/**
 * Authenticated client for account reads. Requires an explicit opt-in.
 * Order placement is still blocked by the adapter's own gate.
 */
export function createApexPrivateClient(config: ApexConfig): ApexClient {
  if (!config.privateApiEnabled) {
    throw new ExchangeConfigurationError(
      "Private ApeX API is disabled (APEX_PRIVATE_API_ENABLED=false)",
    );
  }

  if (!hasApexCredentials(config)) {
    throw new ExchangeConfigurationError(
      "Private ApeX API requires OMNIAPEX_API_KEY, OMNIAPEX_API_SECRET and " +
        "OMNIAPEX_PASS_PHRASE",
    );
  }

  const { apiKey, secret, passphrase, seeds } = config.credentials;

  const client = new ccxt.apex({
    ...baseOptions(),
    apiKey,
    secret,
    password: passphrase,
    options: {
      ...baseOptions().options,
      ...(seeds ? { seeds } : {}),
    },
  });

  if (config.privateApiEnvironment === "testnet") {
    client.setSandboxMode(true);
  }

  return client;
}
