import { describe, expect, test } from "bun:test";
import type { MarketInterface } from "ccxt";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";
import type { MarketInfo } from "../exchanges/exchange.types";
import { normalizeCandle } from "../exchanges/normalizers";
import {
  isEligibleLighterPerpetual,
  normalizeLighterMarket,
  selectInitialUniverse,
} from "../exchanges/lighter/lighter.market-mapper";
import { normalizeLighterFundingRows } from "../exchanges/lighter/lighter.adapter";

function rawMarket(overrides: Record<string, unknown> = {}): MarketInterface {
  return {
    id: "1",
    symbol: "BTC/USDC:USDC",
    base: "BTC",
    quote: "USDC",
    settle: "USDC",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    active: true,
    maker: 0,
    taker: 0,
    precision: { price: 0.1, amount: 0.00001 },
    limits: {
      amount: { min: 0.00007 },
      cost: { min: 10 },
    },
    info: {
      symbol: "BTC",
      market_id: 1,
      market_type: "perp",
      status: "active",
      is_frozen: false,
      min_base_amount: "0.00007",
      min_quote_amount: "10.000000",
      price_decimals: 1,
      size_decimals: 5,
      multiplier: "1.000000000000000000",
      default_initial_margin_fraction: 500,
      min_initial_margin_fraction: 200,
      maintenance_margin_fraction: 120,
      maker_fee: "0.0000",
      taker_fee: "0.0000",
    },
    ...overrides,
  } as unknown as MarketInterface;
}

function marketInfo(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    exchange: "lighter",
    symbol: "BTC/USDC:USDC",
    exchangeSymbol: "1",
    base: "BTC",
    quote: "USDC",
    settle: "USDC",
    type: "swap",
    linear: true,
    inverse: false,
    contract: true,
    active: true,
    contractSize: 1,
    priceTick: 0.1,
    amountStep: 0.00001,
    minAmount: 0.00007,
    maxAmount: null,
    minCost: 10,
    minLeverage: 1,
    maxLeverage: 50,
    initialMarginRate: 0.05,
    maintenanceMarginRate: 0.012,
    makerFee: 0,
    takerFee: 0,
    raw: null,
    ...overrides,
  };
}

describe("Lighter market mapper", () => {
  test("extracts linear USDC perpetual contract specifications", () => {
    const market = normalizeLighterMarket("lighter", rawMarket());

    expect(market).not.toBeNull();
    expect(market!.symbol).toBe("BTC/USDC:USDC");
    expect(market!.exchangeSymbol).toBe("1");
    expect(market!.quote).toBe("USDC");
    expect(market!.settle).toBe("USDC");
    expect(market!.contractSize).toBe(1);
    expect(market!.priceTick).toBe(0.1);
    expect(market!.amountStep).toBe(0.00001);
    expect(market!.minAmount).toBe(0.00007);
    expect(market!.minCost).toBe(10);
    // 500 basis points = 5% initial margin; 200 = 50x maximum leverage.
    expect(market!.initialMarginRate).toBe(0.05);
    expect(market!.maintenanceMarginRate).toBe(0.012);
    expect(market!.maxLeverage).toBe(50);
  });

  test("falls back to decimal fields when CCXT precision is absent", () => {
    const market = normalizeLighterMarket(
      "lighter",
      rawMarket({ precision: {}, limits: {} }),
    )!;

    expect(market.priceTick).toBe(0.1);
    expect(market.amountStep).toBe(0.00001);
    expect(market.minAmount).toBe(0.00007);
    expect(market.minCost).toBe(10);
  });

  test("marks frozen markets inactive", () => {
    const frozen = normalizeLighterMarket(
      "lighter",
      rawMarket({ info: { market_type: "perp", status: "active", is_frozen: true } }),
    )!;

    expect(frozen.active).toBe(false);
    expect(isEligibleLighterPerpetual(frozen)).toBe(false);
  });

  test("rejects non-perpetual contracts", () => {
    const spot = normalizeLighterMarket(
      "lighter",
      rawMarket({ type: "spot", swap: false, symbol: "BTC/USDC" }),
    )!;

    expect(isEligibleLighterPerpetual(spot)).toBe(false);
  });

  test("accepts only linear USDC-quoted USDC perpetuals", () => {
    expect(isEligibleLighterPerpetual(marketInfo())).toBe(true);
    expect(isEligibleLighterPerpetual(marketInfo({ settle: "USDT" }))).toBe(
      false,
    );
    expect(isEligibleLighterPerpetual(marketInfo({ quote: "USDT" }))).toBe(
      false,
    );
    expect(isEligibleLighterPerpetual(marketInfo({ inverse: true }))).toBe(
      false,
    );
    expect(isEligibleLighterPerpetual(marketInfo({ type: "spot" }))).toBe(
      false,
    );
    expect(isEligibleLighterPerpetual(marketInfo({ active: false }))).toBe(
      false,
    );
  });

  test("selects majors and resolves native ids", () => {
    const markets = [
      marketInfo(),
      marketInfo({
        symbol: "ETH/USDC:USDC",
        exchangeSymbol: "0",
        base: "ETH",
      }),
      marketInfo({
        symbol: "DOGE/USDC:USDC",
        exchangeSymbol: "42",
        base: "DOGE",
      }),
    ];

    expect(selectInitialUniverse(markets).map((m) => m.base)).toEqual([
      "BTC",
      "ETH",
      "DOGE",
    ]);
    expect(
      selectInitialUniverse(markets, ["ETH/USDC:USDC"]).map((m) => m.base),
    ).toEqual(["ETH"]);
    expect(selectInitialUniverse(markets, ["42"]).map((m) => m.base)).toEqual([
      "DOGE",
    ]);
  });

  test("rejects an explicit symbol that is not an eligible perpetual", () => {
    const markets = [marketInfo({ settle: "USDT" })];

    expect(() => selectInitialUniverse(markets, ["BTC"])).toThrow(
      ExchangeConfigurationError,
    );
  });
});

describe("Lighter candle normalization", () => {
  const openTime = 1_700_000_000_000;
  const now = openTime + 600_000;

  test("treats an omitted volume as zero", () => {
    const candle = normalizeCandle(
      [openTime, 100, 101, 99, 100.5, undefined],
      "ARM/USDC:USDC",
      "5m",
      now,
      { zeroMissingVolume: true },
    );

    expect(candle).not.toBeNull();
    expect(candle!.volume).toBe(0);
  });

  test("stays strict for venues that do not omit zero volumes", () => {
    expect(
      normalizeCandle(
        [openTime, 100, 101, 99, 100.5, undefined],
        "ARM/USDC:USDC",
        "5m",
        now,
      ),
    ).toBeNull();
  });
});

describe("Lighter funding normalization", () => {
  const rows = [
    { timestamp: 1_700_000_000, rate: "0.0001" },
    { timestamp: 1_699_996_400, rate: 0.0002 },
    { timestamp: "bad", rate: "0.1" },
    { timestamp: 1_700_003_600, rate: "0.0003" },
  ];

  test("converts seconds to milliseconds and sorts ascending", () => {
    const rates = normalizeLighterFundingRows(rows, "BTC/USDC:USDC");

    expect(rates.map((rate) => rate.timestamp)).toEqual([
      1_699_996_400_000,
      1_700_000_000_000,
      1_700_003_600_000,
    ]);
    expect(rates[1]!.rate).toBe(0.0001);
    expect(rates[1]!.symbol).toBe("BTC/USDC:USDC");
  });

  test("filters by since and keeps the newest entries", () => {
    const filtered = normalizeLighterFundingRows(
      rows,
      "BTC/USDC:USDC",
      1_700_000_000_000,
    );
    expect(filtered).toHaveLength(2);

    const limited = normalizeLighterFundingRows(rows, "BTC/USDC:USDC", undefined, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.timestamp).toBe(1_700_003_600_000);
  });
});
