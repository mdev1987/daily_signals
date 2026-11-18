import { describe, expect, test } from "bun:test";
import { ApexAdapter } from "../exchanges/apex/apex.adapter";
import { createApexPrivateClient } from "../exchanges/apex/apex.client";
import {
  assertOrderSubmissionAllowed,
  loadApexConfig,
} from "../exchanges/apex/apex.config";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";

describe("ApeX configuration and order safety", () => {
  test("defaults to public mainnet data with trading disabled", () => {
    const config = loadApexConfig({});

    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnabled).toBe(false);
    expect(config.orderSubmissionEnabled).toBe(false);
    expect(config.tradingMode).toBe("paper");
    expect(config.liveTradingEnabled).toBe(false);
  });

  test("separates market data, private API and execution environments", () => {
    const config = loadApexConfig({
      APEX_MARKET_DATA_ENV: "mainnet",
      APEX_PRIVATE_API_ENV: "testnet",
      APEX_PRIVATE_API_ENABLED: "true",
      TRADING_MODE: "paper",
      APEX_ORDER_SUBMISSION_ENABLED: "false",
      OMNIAPEX_API_KEY: "key",
      OMNIAPEX_API_SECRET: "secret",
      OMNIAPEX_PASS_PHRASE: "pass",
    });

    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.privateApiEnabled).toBe(true);
  });

  test("legacy APEX_ENV still selects the environment", () => {
    const config = loadApexConfig({ APEX_ENV: "testnet" });
    expect(config.marketDataEnvironment).toBe("testnet");
    expect(config.privateApiEnvironment).toBe("testnet");
  });

  test("rejects unknown environments", () => {
    expect(() => loadApexConfig({ APEX_ENV: "staging" })).toThrow(
      ExchangeConfigurationError,
    );
  });

  test("rejects an unknown trading mode instead of guessing", () => {
    expect(() => loadApexConfig({ TRADING_MODE: "research" })).toThrow(
      ExchangeConfigurationError,
    );
    expect(loadApexConfig({ TRADING_MODE: "live" }).tradingMode).toBe("live");
  });

  test("requires every gate before order submission is allowed", () => {
    expect(() => assertOrderSubmissionAllowed(loadApexConfig({}))).toThrow(
      ExchangeConfigurationError,
    );

    const paper = loadApexConfig({
      APEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "paper",
      APEX_OMNI_SEEDS: "seeds",
    });
    expect(() => assertOrderSubmissionAllowed(paper)).toThrow(
      ExchangeConfigurationError,
    );

    const noSeeds = loadApexConfig({
      APEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
    });
    expect(() => assertOrderSubmissionAllowed(noSeeds)).toThrow(
      ExchangeConfigurationError,
    );

    const live = loadApexConfig({
      APEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
      APEX_OMNI_SEEDS: "seeds",
    });
    expect(() => assertOrderSubmissionAllowed(live)).not.toThrow();
  });

  test("private client creation requires an explicit opt-in", () => {
    expect(() => createApexPrivateClient(loadApexConfig({}))).toThrow(
      ExchangeConfigurationError,
    );
  });

  test("adapter refuses to submit an order before any network call", async () => {
    const adapter = new ApexAdapter({ config: loadApexConfig({}) });

    await expect(
      adapter.createOrder({
        symbol: "BTC/USDT:USDT",
        type: "market",
        side: "buy",
        amount: 0.001,
        price: 60_000,
      }),
    ).rejects.toThrow(ExchangeConfigurationError);
  });

  test("adapter blocks cancellation while order submission is disabled", async () => {
    const adapter = new ApexAdapter({ config: loadApexConfig({}) });

    await expect(
      adapter.cancelOrder("order-id", "BTC/USDT:USDT"),
    ).rejects.toThrow(ExchangeConfigurationError);
  });
});
