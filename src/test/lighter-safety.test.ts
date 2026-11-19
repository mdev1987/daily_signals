import { describe, expect, test } from "bun:test";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import { UnsupportedOperationError } from "../exchanges/exchange.errors";
import { createExchangeAdapter } from "../exchanges/exchange.factory";
import { LighterAdapter } from "../exchanges/lighter/lighter.adapter";
import {
  assertLighterOrderSubmissionAllowed,
  describeLighterConfig,
  hasLighterCredentials,
  loadLighterConfig,
} from "../exchanges/lighter/lighter.config";
import { createLighterPrivateClient, createLighterPublicClient } from "../exchanges/lighter/lighter.client";

const CREDENTIALS = {
  LIGHTER_PRIVATE_KEY: "a".repeat(80),
  LIGHTER_PUBLIC_KEY: "b".repeat(80),
  LIGHTER_ACCOUNT_INDEX: "887",
  LIGHTER_KEY_INDEX: "4",
};

describe("Lighter configuration and order safety", () => {
  test("defaults to testnet public data with trading disabled", () => {
    const config = loadLighterConfig({});

    expect(config.marketDataEnvironment).toBe("testnet");
    expect(config.privateApiEnabled).toBe(false);
    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.orderSubmissionEnabled).toBe(false);
    expect(config.tradingMode).toBe("paper");
    expect(config.liveTradingEnabled).toBe(false);
    expect(config.chainId).toBe(300);
    // Testnet follows the web app, where users create accounts and API keys.
    expect(config.baseUrls.testnet).toBe("https://api.testnet.lighter.xyz");
    expect(config.baseUrls.mainnet).toBe(
      "https://mainnet.zklighter.elliot.ai",
    );
  });

  test("base URLs are overridable per environment", () => {
    const config = loadLighterConfig({
      LIGHTER_MAINNET_BASE_URL: "https://example.test/mainnet/",
      LIGHTER_TESTNET_BASE_URL: "https://testnet.zklighter.elliot.ai",
    });

    // Trailing slashes are stripped so URL joins stay predictable.
    expect(config.baseUrls.mainnet).toBe("https://example.test/mainnet");
    expect(config.baseUrls.testnet).toBe(
      "https://testnet.zklighter.elliot.ai",
    );
  });

  test("rejects non-HTTPS or malformed base URLs", () => {
    for (const value of ["http://insecure.test", "not-a-url", "ftp://x.test"]) {
      expect(() =>
        loadLighterConfig({ LIGHTER_TESTNET_BASE_URL: value }),
      ).toThrow(ExchangeConfigurationError);
    }
  });

  test("clients use the base URL of their own environment", () => {
    const publicClient = createLighterPublicClient(
      loadLighterConfig({ LIGHTER_MARKET_DATA_ENV: "mainnet" }),
    );
    expect(
      (publicClient.urls as unknown as { api: { public: string } }).api.public,
    ).toBe("https://mainnet.zklighter.elliot.ai");

    const testnetClient = createLighterPublicClient(loadLighterConfig({}));
    expect(
      (testnetClient.urls as unknown as { api: { public: string } }).api.public,
    ).toBe("https://api.testnet.lighter.xyz");

    const privateClient = createLighterPrivateClient(
      loadLighterConfig({
        ...CREDENTIALS,
        LIGHTER_PRIVATE_API_ENABLED: "true",
        LIGHTER_TESTNET_BASE_URL: "https://testnet.zklighter.elliot.ai",
      }),
    );
    expect(
      (privateClient.urls as unknown as { api: { private: string } }).api
        .private,
    ).toBe("https://testnet.zklighter.elliot.ai");
  });

  test("an explicit chain id survives sandbox mode", () => {
    const client = createLighterPrivateClient(
      loadLighterConfig({
        ...CREDENTIALS,
        LIGHTER_PRIVATE_API_ENABLED: "true",
        LIGHTER_CHAIN_ID: "304",
      }),
    );

    expect((client.options as Record<string, unknown>).chainId).toBe(304);
  });

  test("separates market data, private API and execution environments", () => {
    const config = loadLighterConfig({
      LIGHTER_MARKET_DATA_ENV: "mainnet",
      LIGHTER_PRIVATE_API_ENV: "testnet",
      LIGHTER_PRIVATE_API_ENABLED: "true",
      LIGHTER_ORDER_SUBMISSION_ENABLED: "false",
    });

    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.privateApiEnabled).toBe(true);
    // Signing follows the private environment, not market data.
    expect(config.chainId).toBe(300);

    const mainnetPrivate = loadLighterConfig({
      LIGHTER_MARKET_DATA_ENV: "testnet",
      LIGHTER_PRIVATE_API_ENV: "mainnet",
    });
    expect(mainnetPrivate.chainId).toBe(304);
  });

  test("legacy LIGHTER_ENV still selects the environment", () => {
    const config = loadLighterConfig({ LIGHTER_ENV: "mainnet" });
    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnvironment).toBe("mainnet");
  });

  test("execution defaults stay closed and bounded", () => {
    const config = loadLighterConfig({});

    expect(config.execution.enabled).toBe(false);
    expect(config.execution.sizeMultiplier).toBe(1);
    expect(config.execution.maxNotionalUsd).toBe(0);
    expect(config.execution.flattenOnShutdown).toBe(true);
  });

  test("rejects an invalid notional cap", () => {
    expect(() =>
      loadLighterConfig({ LIGHTER_MAX_NOTIONAL_USD: "-5" }),
    ).toThrow(ExchangeConfigurationError);
  });

  test("refuses a size multiplier without a notional cap", () => {
    expect(() =>
      loadLighterConfig({ LIGHTER_SIZE_MULTIPLIER: "5" }),
    ).toThrow(/LIGHTER_MAX_NOTIONAL_USD/);

    const capped = loadLighterConfig({
      LIGHTER_SIZE_MULTIPLIER: "5",
      LIGHTER_MAX_NOTIONAL_USD: "100",
    });
    expect(capped.execution.sizeMultiplier).toBe(5);
    expect(capped.execution.maxNotionalUsd).toBe(100);
  });

  test("rejects unknown environments instead of guessing", () => {
    expect(() => loadLighterConfig({ LIGHTER_ENV: "staging" })).toThrow(
      ExchangeConfigurationError,
    );
  });

  test("recognizes the API key, index and legacy typo names", () => {
    const config = loadLighterConfig(CREDENTIALS);

    expect(config.credentials.apiKey).toBe(CREDENTIALS.LIGHTER_PRIVATE_KEY);
    expect(config.credentials.accountIndex).toBe(887);
    expect(config.credentials.apiKeyIndex).toBe(4);
    expect(hasLighterCredentials(config)).toBe(true);

    const typo = loadLighterConfig({
      LIGHTHER_PRIVATE_KEY: "c",
      LIGHTHER_PUBLICK_KEY: "d",
    });
    expect(typo.credentials.apiKey).toBe("c");
    expect(typo.credentials.publicKey).toBe("d");
  });

  test("rejects reserved, out-of-range and non-integer key indexes", () => {
    for (const value of ["0", "1", "3", "255", "-1", "abc", "4.5"]) {
      expect(() =>
        loadLighterConfig({ ...CREDENTIALS, LIGHTER_KEY_INDEX: value }),
      ).toThrow(ExchangeConfigurationError);
    }

    expect(
      loadLighterConfig({ ...CREDENTIALS, LIGHTER_KEY_INDEX: "254" }).credentials
        .apiKeyIndex,
    ).toBe(254);
  });

  test("describes the config without exposing the API key", () => {
    const summary = JSON.stringify(
      describeLighterConfig(loadLighterConfig(CREDENTIALS)),
    );

    expect(summary).not.toContain(CREDENTIALS.LIGHTER_PRIVATE_KEY);
    expect(summary).toContain('"accountIndex":887');
    expect(summary).toContain('"apiKeyIndex":4');
  });

  test("requires every gate before order submission is allowed", () => {
    expect(() =>
      assertLighterOrderSubmissionAllowed(loadLighterConfig({})),
    ).toThrow(ExchangeConfigurationError);

    const paper = loadLighterConfig({
      ...CREDENTIALS,
      LIGHTER_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "paper",
    });
    expect(() => assertLighterOrderSubmissionAllowed(paper)).toThrow(
      ExchangeConfigurationError,
    );

    const noCredentials = loadLighterConfig({
      LIGHTER_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
    });
    expect(() => assertLighterOrderSubmissionAllowed(noCredentials)).toThrow(
      ExchangeConfigurationError,
    );

    const live = loadLighterConfig({
      ...CREDENTIALS,
      LIGHTER_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
    });
    expect(() => assertLighterOrderSubmissionAllowed(live)).not.toThrow();
  });

  test("private client creation requires an explicit opt-in", () => {
    expect(() => createLighterPrivateClient(loadLighterConfig({}))).toThrow(
      ExchangeConfigurationError,
    );

    expect(() =>
      createLighterPrivateClient(
        loadLighterConfig({ LIGHTER_PRIVATE_API_ENABLED: "true" }),
      ),
    ).toThrow(ExchangeConfigurationError);
  });

  test("private client attaches the key and both indexes to CCXT", () => {
    const client = createLighterPrivateClient(
      loadLighterConfig({
        ...CREDENTIALS,
        LIGHTER_PRIVATE_API_ENABLED: "true",
      }),
    );

    const options = client.options as Record<string, unknown>;
    expect(options.accountIndex).toBe(887);
    expect(options.apiKeyIndex).toBe(4);
    expect(options.chainId).toBe(300);
    expect((options.auths as Record<string, never>)["887"]).toBeDefined();
  });

  test("adapter refuses to submit or cancel before any network call", async () => {
    const adapter = new LighterAdapter({ config: loadLighterConfig({}) });

    await expect(
      adapter.createOrder({
        symbol: "BTC/USDC:USDC",
        type: "market",
        side: "buy",
        amount: 0.001,
        price: 65_000,
      }),
    ).rejects.toThrow(ExchangeConfigurationError);

    await expect(
      adapter.cancelOrder("order-id", "BTC/USDC:USDC"),
    ).rejects.toThrow(ExchangeConfigurationError);
  });

  test("adapter rejects unsupported timeframes before any network call", async () => {
    const adapter = new LighterAdapter({ config: loadLighterConfig({}) });

    await expect(
      adapter.getOHLCV("BTC/USDC:USDC", "2h", undefined, 10),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  test("factory builds every adapter and rejects unknown venues", () => {
    expect(createExchangeAdapter({ exchange: "lighter" }).id).toBe("lighter");
    expect(createExchangeAdapter({ exchange: "paradex" }).id).toBe("paradex");
    expect(createExchangeAdapter({ exchange: "apex" }).id).toBe("apex");
    expect(() => createExchangeAdapter({ exchange: "kraken" })).toThrow(
      ExchangeConfigurationError,
    );
  });
});
