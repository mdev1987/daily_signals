import { describe, expect, test } from "bun:test";
import {
  PHASE7_CONFIG,
  isDirectionalReversal,
  signalDirection,
} from "../paper-trading";
import { timeframeToMs } from "../config";

describe("Phase 7 operational strategy", () => {
  test("converts configured timeframes from seconds to milliseconds", () => {
    expect(timeframeToMs("5m")).toBe(300_000);
    expect(timeframeToMs("15m")).toBe(900_000);
    expect(timeframeToMs("1h")).toBe(3_600_000);
    expect(timeframeToMs("5h")).toBe(18_000_000);
    expect(timeframeToMs("1d")).toBe(86_400_000);
    expect(timeframeToMs("unknown")).toBeNaN();
  });

  test("uses 1h, 5h, and 1d as primary entry timeframes", () => {
    expect(PHASE7_CONFIG.primaryTimeframes).toEqual(["1h", "5h", "1d"]);
  });

  test("keeps 5m, 15m, and 30m as monitoring-only timeframes", () => {
    expect(PHASE7_CONFIG.monitorTimeframes).toEqual(["5m", "15m", "30m"]);
  });

  test("maps directional signal states to long and short", () => {
    expect(signalDirection("BUY")).toBe("long");
    expect(signalDirection("STRONG_BUY")).toBe("long");
    expect(signalDirection("SELL")).toBe("short");
    expect(signalDirection("STRONG_SELL")).toBe("short");
    expect(signalDirection("NEUTRAL")).toBeNull();
  });

  test("only an explicit opposite direction closes a position", () => {
    expect(isDirectionalReversal("SELL", "long")).toBe(true);
    expect(isDirectionalReversal("STRONG_SELL", "long")).toBe(true);
    expect(isDirectionalReversal("BUY", "short")).toBe(true);
    expect(isDirectionalReversal("NEUTRAL", "long")).toBe(false);
    expect(isDirectionalReversal("NEUTRAL", "short")).toBe(false);
    expect(isDirectionalReversal("BUY", "long")).toBe(false);
    expect(isDirectionalReversal("SELL", "short")).toBe(false);
  });

  test("keeps the one-week and five-minute confirmation rules fixed", () => {
    expect(PHASE7_CONFIG.durationMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(PHASE7_CONFIG.entryConfirmationMs).toBe(5 * 60 * 1_000);
  });
});
