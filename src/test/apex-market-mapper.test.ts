import { describe, expect, test } from "bun:test";
import type { MarketInterface } from "ccxt";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import {
  isEligibleApexPerpetual,
  normalizeApexMarket,
  selectInitialUniverse,
} from "../exchanges/apex/apex.market-mapper";
import type { MarketInfo } from "../exchanges/exchange.types";

function rawMarket(overrides: Record<string, unknown> = {}): MarketInterface {
  return {
    id: "BTC-USDT",
    symbol: "BTC/USDT:USDT",
    base: "BTC",
    quote: "USDT",
    settle: "USDT",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    active: true,
    maker: 0.0005,
    taker: 0.0002,
    precision: { price: 0.1, amount: 0.001 },
    limits: {
      amount: { min: 0.001, max: 50 },
      leverage: { min: 1, max: 100 },
    },
    info: {
      tickSize: "0.1",
      stepSize: "0.001",
      minOrderSize: "0.001",
      maxOrderSize: "50",
      displayMinLeverage: "1",
      displayMaxLeverage: "100",
      initialMarginRate: "0.01",
      maintenanceMarginRate: "0.005",
    },
    ...overrides,
  } as unknown as MarketInterface;
}

function marketInfo(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    exchange: "apex",
    symbol: "BTC/USDT:USDT",
    exchangeSymbol: "BTC-USDT",
    base: "BTC",
    quote: "USDT",
    settle: "USDT",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    active: true,
    contractSize: 1,
    priceTick: 0.1,
    amountStep: 0.001,
    minAmount: 0.001,
    maxAmount: 50,
    minCost: null,
    minLeverage: 1,
    maxLeverage: 100,
    initialMarginRate: 0.01,
    maintenanceMarginRate: 0.005,
    makerFee: 0.0005,
    takerFee: 0.0002,
    raw: null,
    ...overrides,
  };
}

describe("ApeX market mapper", () => {
  test("extracts contract specifications from the exchange payload", () => {
    const market = normalizeApexMarket("apex", rawMarket());
    expect(market).not.toBeNull();
    expect(market!.symbol).toBe("BTC/USDT:USDT");
    expect(market!.exchangeSymbol).toBe("BTC-USDT");
    // ApeX sizes are base units; there is no separate contract multiplier.
    expect(market!.contractSize).toBe(1);
    expect(market!.priceTick).toBe(0.1);
    expect(market!.amountStep).toBe(0.001);
    expect(market!.minAmount).toBe(0.001);
    expect(market!.maxAmount).toBe(50);
    expect(market!.minLeverage).toBe(1);
    expect(market!.maxLeverage).toBe(100);
    expect(market!.initialMarginRate).toBe(0.01);
    expect(market!.maintenanceMarginRate).toBe(0.005);
  });

  test("falls back to CCXT precision when raw fields are absent", () => {
    const market = normalizeApexMarket(
      "apex",
      rawMarket({ info: {} }),
    );
    expect(market!.priceTick).toBe(0.1);
    expect(market!.amountStep).toBe(0.001);
    expect(market!.minAmount).toBe(0.001);
  });

  test("only active linear USDT perpetuals are eligible", () => {
    expect(isEligibleApexPerpetual(marketInfo())).toBe(true);
    expect(isEligibleApexPerpetual(marketInfo({ active: false }))).toBe(false);
    expect(isEligibleApexPerpetual(marketInfo({ linear: false }))).toBe(false);
    expect(isEligibleApexPerpetual(marketInfo({ inverse: true }))).toBe(false);
    expect(isEligibleApexPerpetual(marketInfo({ settle: "USDC" }))).toBe(false);
    expect(isEligibleApexPerpetual(marketInfo({ quote: "USDC" }))).toBe(false);
    expect(isEligibleApexPerpetual(marketInfo({ type: "spot" }))).toBe(false);
  });

  test("defaults to liquid majors in the declared order", () => {
    const markets = [
      marketInfo({ symbol: "SOL/USDT:USDT", exchangeSymbol: "SOL-USDT", base: "SOL" }),
      marketInfo(),
      marketInfo({ symbol: "ETH/USDT:USDT", exchangeSymbol: "ETH-USDT", base: "ETH" }),
      marketInfo({ symbol: "DOGE/USDC:USDC", exchangeSymbol: "DOGE-USDC", base: "DOGE", quote: "USDC", settle: "USDC" }),
    ];

    const universe = selectInitialUniverse(markets);
    expect(universe.map((m) => m.base)).toEqual(["BTC", "ETH", "SOL"]);
    expect(selectInitialUniverse(markets, [], 2).map((m) => m.base)).toEqual([
      "BTC",
      "ETH",
    ]);
  });

  test("explicit symbols accept unified, exchange-native and base forms", () => {
    const markets = [
      marketInfo(),
      marketInfo({ symbol: "ETH/USDT:USDT", exchangeSymbol: "ETH-USDT", base: "ETH" }),
    ];

    expect(selectInitialUniverse(markets, ["ETH/USDT:USDT"])[0]!.base).toBe("ETH");
    expect(selectInitialUniverse(markets, ["ETH-USDT"])[0]!.base).toBe("ETH");
    expect(selectInitialUniverse(markets, ["BTCUSDT"])[0]!.base).toBe("BTC");
  });

  test("unknown or ineligible requests fail explicitly", () => {
    const markets = [marketInfo()];

    expect(() => selectInitialUniverse(markets, ["NOPE"])).toThrow(
      ExchangeConfigurationError,
    );
    expect(() =>
      selectInitialUniverse(
        [marketInfo({ active: false })],
        ["BTC"],
      ),
    ).toThrow(ExchangeConfigurationError);
  });

  test("falls back to alphabetical order when no majors are listed", () => {
    const markets = [
      marketInfo({ symbol: "ZZZ/USDT:USDT", exchangeSymbol: "ZZZ-USDT", base: "ZZZ" }),
      marketInfo({ symbol: "AAA/USDT:USDT", exchangeSymbol: "AAA-USDT", base: "AAA" }),
    ];

    expect(selectInitialUniverse(markets).map((m) => m.base)).toEqual([
      "AAA",
      "ZZZ",
    ]);
  });
});
