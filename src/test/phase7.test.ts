import { describe, expect, test } from "bun:test";
import { PHASE7_CONFIG, signalDirection } from "../paper-trading";

describe("Phase 7 operational strategy", () => {
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

  test("keeps the one-week and five-minute confirmation rules fixed", () => {
    expect(PHASE7_CONFIG.durationMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(PHASE7_CONFIG.entryConfirmationMs).toBe(5 * 60 * 1_000);
  });
});
