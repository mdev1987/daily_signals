import { describe, expect, test } from "bun:test";
import type { Candle } from "../exchanges/exchange.types";
import {
  CandleManager,
  alignToTimeframe,
  lastClosedCandleOpenTime,
} from "../market-data/candle-manager";

const TF = 300_000;
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % TF);

function candle(openTime: number, isFinal: boolean): Candle {
  return {
    symbol: "BTC/USDT:USDT",
    timeframe: "5m",
    openTime,
    closeTime: openTime + TF,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    turnover: null,
    isFinal,
  };
}

describe("candle manager", () => {
  test("evaluates a completed candle exactly once", () => {
    const manager = new CandleManager();
    const completed = candle(BASE, true);

    expect(manager.ingest(completed)).toEqual({
      isNewInterval: true,
      shouldEvaluate: true,
      isInProgress: false,
    });

    // A resend of the same candle must not trigger a second evaluation.
    expect(manager.ingest(completed)).toEqual({
      isNewInterval: false,
      shouldEvaluate: false,
      isInProgress: false,
    });
  });

  test("never evaluates an in-progress candle", () => {
    const manager = new CandleManager();
    const forming = candle(BASE + TF, false);

    expect(manager.ingest(forming)).toEqual({
      isNewInterval: true,
      shouldEvaluate: false,
      isInProgress: true,
    });
    expect(manager.getLastEvaluatedOpenTime("BTC/USDT:USDT", "5m")).toBeNull();
  });

  test("ignores a stale finalized candle", () => {
    const manager = new CandleManager();
    manager.ingest(candle(BASE, true));
    manager.ingest(candle(BASE + TF, true));

    const stale = manager.ingest(candle(BASE, true));
    expect(stale.shouldEvaluate).toBe(false);
  });

  test("restores state after a restart", () => {
    const manager = new CandleManager();
    manager.restoreLastEvaluatedOpenTime("BTC/USDT:USDT", "5m", BASE);

    expect(manager.ingest(candle(BASE, true)).shouldEvaluate).toBe(false);
    expect(manager.ingest(candle(BASE + TF, true)).shouldEvaluate).toBe(true);
  });

  test("aligns timestamps and finds the last closed candle", () => {
    expect(alignToTimeframe(BASE + 12_345, TF)).toBe(BASE);
    expect(lastClosedCandleOpenTime(BASE + TF, TF)).toBe(BASE);
    expect(lastClosedCandleOpenTime(BASE + TF / 2, TF)).toBe(BASE - TF);
  });
});
