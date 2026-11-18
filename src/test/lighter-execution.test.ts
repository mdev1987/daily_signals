import { describe, expect, test } from "bun:test";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import type { OrderBook } from "../exchanges/exchange.types";
import {
  assertLighterExecutionAllowed,
  DEFAULT_EXECUTION_SYMBOLS,
  describeLighterConfig,
  loadLighterConfig,
} from "../exchanges/lighter/lighter.config";
import {
  floorToAmountStep,
  toLighterPerpetualSymbol,
} from "../exchanges/lighter/lighter.market-mapper";
import {
  isManagedVenueSymbol,
  orderAuditStatus,
  orderReference,
  worstAcceptablePrice,
} from "../exchanges/lighter/lighter.execution";

const CREDENTIALS = {
  LIGHTER_PRIVATE_KEY: "a".repeat(80),
  LIGHTER_PUBLIC_KEY: "b".repeat(80),
  LIGHTER_ACCOUNT_INDEX: "281474976710647",
  LIGHTER_KEY_INDEX: "4",
};

const EXECUTION_ENABLED = {
  ...CREDENTIALS,
  LIGHTER_PRIVATE_API_ENABLED: "true",
  LIGHTER_ORDER_SUBMISSION_ENABLED: "true",
  LIGHTER_EXECUTION_ENABLED: "true",
  TRADING_MODE: "live",
  LIVE_TRADING_ENABLED: "true",
};

function book(bids: number[], asks: number[]): OrderBook {
  return {
    symbol: "BTC/USDC:USDC",
    timestamp: null,
    bids: bids.map((price) => ({ price, amount: 1 })),
    asks: asks.map((price) => ({ price, amount: 1 })),
  };
}

describe("Lighter futures execution configuration", () => {
  test("execution is off by default with testnet-friendly defaults", () => {
    const config = loadLighterConfig({});

    expect(config.execution.enabled).toBe(false);
    expect(config.execution.leverage).toBe(5);
    expect(config.execution.marginMode).toBe("cross");
    expect(config.execution.symbols).toEqual([...DEFAULT_EXECUTION_SYMBOLS]);
    expect(config.execution.allowMainnetExecution).toBe(false);
  });

  test("leverage and margin mode are configurable", () => {
    const config = loadLighterConfig({
      LIGHTER_EXECUTION_ENABLED: "true",
      LIGHTER_LEVERAGE: "10",
      LIGHTER_MARGIN_MODE: "isolated",
      LIGHTER_EXECUTION_SYMBOLS: "btc, eth",
      LIGHTER_WORST_PRICE_SLIPPAGE_PCT: "2.5",
    });

    expect(config.execution.enabled).toBe(true);
    expect(config.execution.leverage).toBe(10);
    expect(config.execution.marginMode).toBe("isolated");
    expect(config.execution.symbols).toEqual(["BTC", "ETH"]);
    expect(config.execution.worstPriceSlippagePct).toBe(2.5);
    expect(describeLighterConfig(config).execution.leverage).toBe(10);
  });

  test("invalid leverage, margin mode and slippage are rejected", () => {
    expect(() => loadLighterConfig({ LIGHTER_LEVERAGE: "0" })).toThrow(
      ExchangeConfigurationError,
    );
    expect(() => loadLighterConfig({ LIGHTER_LEVERAGE: "2.5" })).toThrow(
      ExchangeConfigurationError,
    );
    expect(() => loadLighterConfig({ LIGHTER_LEVERAGE: "51" })).toThrow(
      ExchangeConfigurationError,
    );
    expect(() =>
      loadLighterConfig({ LIGHTER_MARGIN_MODE: "portfolio" }),
    ).toThrow(ExchangeConfigurationError);
    expect(() =>
      loadLighterConfig({ LIGHTER_WORST_PRICE_SLIPPAGE_PCT: "25" }),
    ).toThrow(ExchangeConfigurationError);
    expect(() =>
      loadLighterConfig({ LIGHTER_EXECUTION_SYMBOLS: " , " }),
    ).toThrow(ExchangeConfigurationError);
  });

  test("execution requires every order gate", () => {
    expect(() =>
      assertLighterExecutionAllowed(
        loadLighterConfig({ ...EXECUTION_ENABLED, LIGHTER_EXECUTION_ENABLED: "false" }),
      ),
    ).toThrow(/LIGHTER_EXECUTION_ENABLED/);

    expect(() =>
      assertLighterExecutionAllowed(
        loadLighterConfig({ ...EXECUTION_ENABLED, TRADING_MODE: "paper" }),
      ),
    ).toThrow(/TRADING_MODE=live/);

    expect(() =>
      assertLighterExecutionAllowed(
        loadLighterConfig({ ...EXECUTION_ENABLED, LIVE_TRADING_ENABLED: "false" }),
      ),
    ).toThrow(/LIVE_TRADING_ENABLED/);

    expect(() =>
      assertLighterExecutionAllowed(
        loadLighterConfig({
          ...EXECUTION_ENABLED,
          LIGHTER_ORDER_SUBMISSION_ENABLED: "false",
        }),
      ),
    ).toThrow(/LIGHTER_ORDER_SUBMISSION_ENABLED/);
  });

  test("mainnet execution needs an explicit opt-in", () => {
    const mainnet = {
      ...EXECUTION_ENABLED,
      LIGHTER_PRIVATE_API_ENV: "mainnet",
    };

    expect(() => assertLighterExecutionAllowed(loadLighterConfig(mainnet))).toThrow(
      /restricted to testnet/,
    );

    expect(() =>
      assertLighterExecutionAllowed(
        loadLighterConfig({
          ...mainnet,
          LIGHTER_ALLOW_MAINNET_EXECUTION: "true",
        }),
      ),
    ).not.toThrow();
  });

  test("a complete testnet configuration passes the execution gate", () => {
    const config = loadLighterConfig(EXECUTION_ENABLED);

    expect(config.privateApiEnvironment).toBe("testnet");
    expect(config.chainId).toBe(300);
    expect(() => assertLighterExecutionAllowed(config)).not.toThrow();
  });
});

describe("Lighter execution symbol mapping", () => {
  const supported = ["BTC", "ETH", "SOL"] as const;

  test("maps signal and canonical symbols to the USDC perpetual", () => {
    expect(toLighterPerpetualSymbol("BTC/USD", supported)).toBe("BTC/USDC:USDC");
    expect(toLighterPerpetualSymbol("BTCUSD", supported)).toBe("BTC/USDC:USDC");
    expect(toLighterPerpetualSymbol("BTCUSDT", supported)).toBe("BTC/USDC:USDC");
    expect(toLighterPerpetualSymbol("eth/usdc", supported)).toBe(
      "ETH/USDC:USDC",
    );
    expect(toLighterPerpetualSymbol("SOL", supported)).toBe("SOL/USDC:USDC");
  });

  test("rejects unsupported bases and non-USD quotes", () => {
    expect(toLighterPerpetualSymbol("XRP/USD", supported)).toBeNull();
    expect(toLighterPerpetualSymbol("BTC/ZAR", supported)).toBeNull();
    expect(toLighterPerpetualSymbol("EUR/USD", supported)).toBeNull();
    expect(toLighterPerpetualSymbol("", supported)).toBeNull();
  });

  test("recognises managed venue positions", () => {
    expect(isManagedVenueSymbol("BTC/USDC:USDC", supported)).toBe(true);
    expect(isManagedVenueSymbol("XRP/USDC:USDC", supported)).toBe(false);
  });
});

describe("Lighter order sizing helpers", () => {
  test("floors quantities to the market step", () => {
    expect(floorToAmountStep(0.000219, 0.00001)).toBe(0.00021);
    expect(floorToAmountStep(0.00799, 0.0001)).toBe(0.0079);
    expect(floorToAmountStep(1.239, 0.01)).toBe(1.23);
    expect(floorToAmountStep(0.5, null)).toBe(0.5);
    expect(floorToAmountStep(0, 0.001)).toBe(0);
    expect(floorToAmountStep(-1, 0.001)).toBe(0);
  });

  test("uses the best quote on the requested side", () => {
    expect(worstAcceptablePrice("buy", book([100], [101]), 100.5, 1)).toBeCloseTo(
      102.01,
      6,
    );
    expect(worstAcceptablePrice("sell", book([100], [101]), 100.5, 1)).toBeCloseTo(
      99,
      6,
    );
  });

  test("falls back to the other side and then the last trade", () => {
    // Thin testnet book: no asks, only a bid.
    expect(worstAcceptablePrice("buy", book([64_000], []), 64_100, 1)).toBeCloseTo(
      64_640,
      6,
    );
    // Completely empty book.
    expect(worstAcceptablePrice("sell", book([], []), 64_100, 1)).toBeCloseTo(
      63_459,
      6,
    );
    expect(worstAcceptablePrice("buy", book([], []), null, 1)).toBeNull();
    expect(worstAcceptablePrice("buy", book([], []), 0, 1)).toBeNull();
  });

  test("audits the transaction hash when an IOC order has no id", () => {
    const ack = {
      id: null,
      clientOrderId: null,
      symbol: "BTC/USDC:USDC",
      type: "market" as const,
      side: "buy" as const,
      price: 64_640,
      amount: 0.00021,
      filled: null,
      remaining: null,
      status: "unknown" as const,
      timestamp: null,
      raw: { tx_hash: "0xabc" },
    };

    expect(orderReference(ack)).toBe("0xabc");
    expect(orderReference({ ...ack, raw: { info: { tx_hash: "0xdef" } } })).toBe(
      "0xdef",
    );
    expect(orderAuditStatus(ack)).toBe("submitted");
    expect(orderReference({ ...ack, id: "42" })).toBe("42");
    expect(orderAuditStatus({ ...ack, status: "closed" })).toBe("closed");
  });
});
