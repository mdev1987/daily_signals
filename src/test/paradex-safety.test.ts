import { describe, expect, test } from "bun:test";
import { ParadexAdapter } from "../exchanges/paradex/paradex.adapter";
import { createParadexPrivateClient } from "../exchanges/paradex/paradex.client";
import {
  assertParadexOrderSubmissionAllowed,
  describeParadexConfig,
  loadParadexConfig,
} from "../exchanges/paradex/paradex.config";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import { UnsupportedOperationError } from "../exchanges/exchange.errors";
import { createExchangeAdapter } from "../exchanges/exchange.factory";

const STARKNET_CREDENTIALS = {
  PARADEX_PRIVATE_KEY: "0x1",
  PARADEX_PUBLICK_KEY: "0x2",
  PARADEX_ADDRESS: "0x3",
};

describe("Paradex configuration and order safety", () => {
  test("defaults to testnet public data with trading disabled", () => {
    const config = loadParadexConfig({});

    expect(config.marketDataEnvironment).toBe("testnet");
    expect(config.privateApiEnabled).toBe(false);
    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.orderSubmissionEnabled).toBe(false);
    expect(config.tradingMode).toBe("paper");
    expect(config.liveTradingEnabled).toBe(false);
  });

  test("separates market data, private API and execution environments", () => {
    const config = loadParadexConfig({
      PARADEX_MARKET_DATA_ENV: "mainnet",
      PARADEX_PRIVATE_API_ENV: "testnet",
      PARADEX_PRIVATE_API_ENABLED: "true",
      PARADEX_ORDER_SUBMISSION_ENABLED: "false",
    });

    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.privateApiEnabled).toBe(true);
  });

  test("legacy PARADEX_ENV still selects the environment", () => {
    const config = loadParadexConfig({ PARADEX_ENV: "mainnet" });
    expect(config.marketDataEnvironment).toBe("mainnet");
    expect(config.privateApiEnvironment).toBe("mainnet");
  });

  test("rejects unknown environments instead of guessing", () => {
    expect(() => loadParadexConfig({ PARADEX_ENV: "staging" })).toThrow(
      ExchangeConfigurationError,
    );
  });

  test("recognizes the local credential names, including the legacy typo", () => {
    const config = loadParadexConfig(STARKNET_CREDENTIALS);

    expect(config.credentials.paradexPrivateKey).toBe("0x1");
    expect(config.credentials.paradexPublicKey).toBe("0x2");
    expect(config.credentials.paradexAddress).toBe("0x3");
    expect(describeParadexConfig(config).authMode).toBe("starknet");
    expect(describeParadexConfig(config).credentialsPresent).toBe(true);
  });

  test("supports an EVM wallet as the alternate auth path", () => {
    const config = loadParadexConfig({
      PARADEX_WALLET_ADDRESS: "0xabc",
      PARADEX_EVM_PRIVATE_KEY: "0xdef",
    });

    expect(describeParadexConfig(config).authMode).toBe("evm");
  });

  test("requires every gate before order submission is allowed", () => {
    expect(() =>
      assertParadexOrderSubmissionAllowed(loadParadexConfig({})),
    ).toThrow(ExchangeConfigurationError);

    const paper = loadParadexConfig({
      ...STARKNET_CREDENTIALS,
      PARADEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "paper",
    });
    expect(() => assertParadexOrderSubmissionAllowed(paper)).toThrow(
      ExchangeConfigurationError,
    );

    const noCredentials = loadParadexConfig({
      PARADEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
    });
    expect(() => assertParadexOrderSubmissionAllowed(noCredentials)).toThrow(
      ExchangeConfigurationError,
    );

    const live = loadParadexConfig({
      ...STARKNET_CREDENTIALS,
      PARADEX_ORDER_SUBMISSION_ENABLED: "true",
      LIVE_TRADING_ENABLED: "true",
      TRADING_MODE: "live",
    });
    expect(() => assertParadexOrderSubmissionAllowed(live)).not.toThrow();
  });

  test("private client creation requires an explicit opt-in", () => {
    expect(() => createParadexPrivateClient(loadParadexConfig({}))).toThrow(
      ExchangeConfigurationError,
    );

    expect(() =>
      createParadexPrivateClient(
        loadParadexConfig({ PARADEX_PRIVATE_API_ENABLED: "true" }),
      ),
    ).toThrow(ExchangeConfigurationError);
  });

  test("private client accepts the StarkNet account keypair", () => {
    const client = createParadexPrivateClient(
      loadParadexConfig({
        ...STARKNET_CREDENTIALS,
        PARADEX_PRIVATE_API_ENABLED: "true",
      }),
    );

    const account = (client.options as Record<string, unknown>).paradexAccount;
    expect(account).toEqual({
      privateKey: "0x1",
      publicKey: "0x2",
      address: "0x3",
    });
  });

  test("adapter refuses to submit or cancel before any network call", async () => {
    const adapter = new ParadexAdapter({ config: loadParadexConfig({}) });

    await expect(
      adapter.createOrder({
        symbol: "BTC/USD:USDC",
        type: "market",
        side: "buy",
        amount: 0.001,
      }),
    ).rejects.toThrow(ExchangeConfigurationError);

    await expect(
      adapter.cancelOrder("order-id", "BTC/USD:USDC"),
    ).rejects.toThrow(ExchangeConfigurationError);
  });

  test("adapter rejects unsupported timeframes before any network call", async () => {
    const adapter = new ParadexAdapter({ config: loadParadexConfig({}) });

    await expect(
      adapter.getOHLCV("BTC/USD:USDC", "4h", undefined, 10),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  test("factory builds the Paradex adapter and rejects unknown venues", () => {
    expect(createExchangeAdapter({ exchange: "paradex" }).id).toBe("paradex");
    expect(createExchangeAdapter({ exchange: "apex" }).id).toBe("apex");
    expect(() => createExchangeAdapter({ exchange: "kraken" })).toThrow(
      ExchangeConfigurationError,
    );
  });
});
