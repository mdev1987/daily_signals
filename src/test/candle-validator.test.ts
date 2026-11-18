import { describe, expect, test } from "bun:test";
import type { Candle } from "../exchanges/exchange.types";
import { validateCandles } from "../market-data/data-validator";

const TF = 300_000;
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % TF);

function candle(index: number, overrides: Partial<Candle> = {}): Candle {
  const openTime = BASE + index * TF;
  return {
    symbol: "BTC/USDT:USDT",
    timeframe: "5m",
    openTime,
    closeTime: openTime + TF,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    turnover: null,
    isFinal: true,
    ...overrides,
  };
}

describe("candle data validation", () => {
  test("accepts a contiguous finalized series", () => {
    const candles = Array.from({ length: 12 }, (_, index) => candle(index));
    const report = validateCandles(candles, TF);

    expect(report.total).toBe(12);
    expect(report.missingIntervals).toBe(0);
    expect(report.invalid).toBe(0);
    expect(report.passed).toBe(true);
  });

  test("sorts unordered input before checking continuity", () => {
    const candles = [candle(2), candle(0), candle(1)];
    const report = validateCandles(candles, TF);

    expect(report.firstOpenTime).toBe(BASE);
    expect(report.lastOpenTime).toBe(BASE + 2 * TF);
    expect(report.missingIntervals).toBe(0);
    expect(report.passed).toBe(true);
  });

  test("reports missing intervals", () => {
    const candles = [candle(0), candle(1), candle(4), candle(5)];
    const report = validateCandles(candles, TF);

    expect(report.missingIntervals).toBe(2);
    expect(report.gaps).toEqual([
      {
        fromOpenTime: BASE + TF,
        toOpenTime: BASE + 4 * TF,
        missing: 2,
      },
    ]);
    expect(report.passed).toBe(false);
  });

  test("detects duplicates", () => {
    const report = validateCandles([candle(0), candle(0), candle(1)], TF);

    expect(report.duplicates).toBe(1);
    expect(report.passed).toBe(false);
  });

  test("detects invalid OHLC relationships and prices", () => {
    const candles = [
      candle(0, { high: 98 }),
      candle(1, { low: 102 }),
      candle(2, { close: -1 }),
      candle(3, { volume: -5 }),
    ];
    const report = validateCandles(candles, TF);

    expect(report.invalid).toBe(4);
    expect(report.passed).toBe(false);
  });

  test("rejects in-progress candles unless explicitly allowed", () => {
    const candles = [candle(0), candle(1, { isFinal: false })];

    const strict = validateCandles(candles, TF);
    expect(strict.nonFinalCandles).toBe(1);
    expect(strict.passed).toBe(false);

    const relaxed = validateCandles(candles, TF, { requireFinal: false });
    expect(relaxed.passed).toBe(true);
  });

  test("flags candles that are not aligned to the timeframe grid", () => {
    const report = validateCandles(
      [candle(0), candle(1, { openTime: BASE + TF + 1 })],
      TF,
    );

    expect(report.misaligned).toBe(1);
    expect(report.passed).toBe(false);
  });

  test("truncates the gap list but keeps the missing total", () => {
    const candles = Array.from({ length: 10 }, (_, index) =>
      candle(index * 10),
    );
    const report = validateCandles(candles, TF, { maxGaps: 3 });

    expect(report.gaps.length).toBe(3);
    expect(report.gapsTruncated).toBe(true);
    expect(report.missingIntervals).toBe(9 * 9);
  });
});
