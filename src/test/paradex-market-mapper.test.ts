import { describe, expect, test } from "bun:test";
import type { MarketInterface } from "ccxt";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import type { MarketInfo } from "../exchanges/exchange.types";
import { normalizeCandle } from "../exchanges/normalizers";
import {
  isEligibleParadexPerpetual,
  normalizeParadexMarket,
  selectInitialUniverse,
} from "../exchanges/paradex/paradex.market-mapper";

function rawMarket(overrides: Record<string, unknown> = {}): MarketInterface {
  return {
    id: "BTC-USD-PERP",
    symbol: "BTC/USD:USDC",
    base: "BTC",
    quote: "USD",
    settle: "USDC",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    // Paradex leaves `active` undefined for listed markets through CCXT.
    active: undefined,
    maker: -0.00005,
    taker: 0.0003,
    precision: { price: 0.1, amount: 0.00001 },
    limits: {
      amount: { max: 100 },
      cost: { min: 10 },
    },
    info: {
      symbol: "BTC-USD-PERP",
      base_currency: "BTC",
      quote_currency: "USD",
      settlement_currency: "USDC",
      price_tick_size: "0.1",
      order_size_increment: "0.00001",
      min_notional: "10",
      max_order_size: "100",
      asset_kind: "PERP",
      expiry_at: 0,
      delta1_cross_margin_params: {
        imf_base: "0.02",
        mmf_factor: "0.5",
      },
    },
    ...overrides,
  } as unknown as MarketInterface;
}

function marketInfo(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    exchange: "paradex",
    symbol: "BTC/USD:USDC",
    exchangeSymbol: "BTC-USD-PERP",
    base: "BTC",
    quote: "USD",
    settle: "USDC",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    active: true,
    contractSize: 1,
    priceTick: 0.1,
    amountStep: 0.00001,
    minAmount: null,
    maxAmount: 100,
    minCost: 10,
    minLeverage: null,
    maxLeverage: null,
    initialMarginRate: 0.02,
    maintenanceMarginRate: 0.01,
    makerFee: -0.00005,
    takerFee: 0.0003,
    raw: null,
    ...overrides,
  };
}

describe("Paradex market mapper", () => {
  test("extracts USDC perpetual contract specifications", () => {
    const market = normalizeParadexMarket("paradex", rawMarket());

    expect(market).not.toBeNull();
    expect(market!.symbol).toBe("BTC/USD:USDC");
    expect(market!.exchangeSymbol).toBe("BTC-USD-PERP");
    expect(market!.quote).toBe("USD");
    expect(market!.settle).toBe("USDC");
    expect(market!.contractSize).toBe(1);
    expect(market!.priceTick).toBe(0.1);
    expect(market!.amountStep).toBe(0.00001);
    expect(market!.maxAmount).toBe(100);
    expect(market!.minCost).toBe(10);
    expect(market!.initialMarginRate).toBe(0.02);
    expect(market!.maintenanceMarginRate).toBe(0.01);
  });

  test("treats an unknown active flag as listed", () => {
    expect(normalizeParadexMarket("paradex", rawMarket())!.active).toBe(true);
    expect(
      normalizeParadexMarket("paradex", rawMarket({ active: false }))!.active,
    ).toBe(false);
  });

  test("rejects explicit inactive and expired markets", () => {
    const inactive = normalizeParadexMarket(
      "paradex",
      rawMarket({ active: false }),
    )!;
    expect(isEligibleParadexPerpetual(inactive)).toBe(false);

    const expired = normalizeParadexMarket(
      "paradex",
      rawMarket({
        info: { asset_kind: "PERP", expiry_at: 1_600_000_000_000 },
      }),
    )!;
    expect(expired.active).toBe(false);
    expect(isEligibleParadexPerpetual(expired)).toBe(false);
  });

  test("accepts only linear USD-quoted USDC perpetuals", () => {
    expect(isEligibleParadexPerpetual(marketInfo())).toBe(true);
    expect(isEligibleParadexPerpetual(marketInfo({ settle: "USDT" }))).toBe(
      false,
    );
    expect(isEligibleParadexPerpetual(marketInfo({ quote: "USDT" }))).toBe(
      false,
    );
    expect(isEligibleParadexPerpetual(marketInfo({ inverse: true }))).toBe(
      false,
    );
    expect(isEligibleParadexPerpetual(marketInfo({ type: "spot" }))).toBe(
      false,
    );
    expect(isEligibleParadexPerpetual(marketInfo({ active: false }))).toBe(
      false,
    );
  });

  test("selects majors and resolves native ids", () => {
    const markets = [
      marketInfo(),
      marketInfo({
        symbol: "ETH/USD:USDC",
        exchangeSymbol: "ETH-USD-PERP",
        base: "ETH",
      }),
      marketInfo({
        symbol: "DOGE/USD:USDC",
        exchangeSymbol: "DOGE-USD-PERP",
        base: "DOGE",
      }),
    ];

    expect(selectInitialUniverse(markets).map((m) => m.base)).toEqual([
      "BTC",
      "ETH",
      "DOGE",
    ]);
    expect(
      selectInitialUniverse(markets, ["ETH-USD-PERP"]).map((m) => m.base),
    ).toEqual(["ETH"]);
    expect(
      selectInitialUniverse(markets, ["BTC/USD:USDC"]).map((m) => m.base),
    ).toEqual(["BTC"]);
  });

  test("rejects an explicit symbol that is not an eligible perpetual", () => {
    const markets = [marketInfo({ settle: "USDT" })];

    expect(() => selectInitialUniverse(markets, ["BTC"])).toThrow(
      ExchangeConfigurationError,
    );
  });
});

describe("Paradex candle normalization", () => {
  // Real Paradex shape: the open carries the previous close, so it can sit
  // outside the traded high/low range.
  const row = [1_700_000_000_000, 64616.8, 64695, 64656.6, 64695, 101] as const;
  const now = 1_700_000_000_000 + 600_000;

  test("widens the range so open and close are inside it", () => {
    const candle = normalizeCandle(
      row,
      "BTC/USD:USDC",
      "5m",
      now,
      { widenRange: true },
    );

    expect(candle).not.toBeNull();
    expect(candle!.low).toBe(64616.8);
    expect(candle!.high).toBe(64695);
    expect(candle!.open).toBe(64616.8);
    expect(candle!.close).toBe(64695);
  });

  test("stays strict for venues without the quirk", () => {
    expect(normalizeCandle(row, "BTC/USD:USDC", "5m", now)).toBeNull();
  });
});
