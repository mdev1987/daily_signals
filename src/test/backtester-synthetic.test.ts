import { describe, it, expect } from "bun:test";
import {
  canOpenPosition,
  computeMetrics,
  simulateExits,
  RISK_SCENARIOS,
  type RiskScenario,
  type StrategyConfig,
  type TradeRecord,
} from "../backtester";

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "trade-synth",
    symbol: "EURUSD",
    direction: "long",
    entryTime: 1_000_000,
    entryPrice: 100,
    exitTime: null,
    exitPrice: null,
    exitReason: "open",
    grossPnL: 0,
    netPnL: 0,
    fees: 0,
    slippage: 0,
    holdingPeriodMs: 0,
    status: "open",
    ...overrides,
  };
}

function makeCandle(closeTime: number, high: number, low: number, close: number) {
  return { open: close, high, low, close, closeTime };
}

const config: StrategyConfig = {
  mainTimeframe: "5m",
  entryDelayMs: 300000,
  directionalSignals: ["BUY", "STRONG_BUY", "SELL", "STRONG_SELL"],
  freshOnly: true,
};

const moderate: RiskScenario = RISK_SCENARIOS.moderate!;
const baseline: RiskScenario = RISK_SCENARIOS.baseline!;

describe("Backtester exit simulation (synthetic cases)", () => {
  it("closes a long position via stop-loss at the stop price", () => {
    const trade = makeTrade({ direction: "long", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 99.5, 97.5, 98)];
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: moderate });

    expect(result.closedTrades).toHaveLength(1);
    expect(result.openTrades).toHaveLength(0);
    expect(result.closedTrades[0]!.status).toBe("closed");
    expect(result.closedTrades[0]!.exitReason).toBe("stop");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(98); // 100 * (1 - 0.02)
    expect(result.closedTrades[0]!.grossPnL).toBeCloseTo(-2);
    expect(result.closedTrades[0]!.holdingPeriodMs).toBe(50_000);
  });

  it("closes a long position via take-profit at the target", () => {
    const trade = makeTrade({ direction: "long", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 104, 100, 102)];
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: moderate });

    expect(result.closedTrades[0]!.exitReason).toBe("target");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(104); // 100 * (1 + 0.04)
    expect(result.closedTrades[0]!.grossPnL).toBeCloseTo(4);
  });

  it("closes a short position via stop-loss at the stop price", () => {
    const trade = makeTrade({ direction: "short", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 102, 101, 101)];
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: moderate });

    expect(result.closedTrades[0]!.exitReason).toBe("stop");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(102); // 100 * (1 + 0.02)
    expect(result.closedTrades[0]!.grossPnL).toBeCloseTo(-2); // short loses on rally
  });

  it("closes a short position via take-profit at the target", () => {
    const trade = makeTrade({ direction: "short", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 99, 96, 98)];
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: moderate });

    expect(result.closedTrades[0]!.exitReason).toBe("target");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(96); // 100 * (1 - 0.04)
    expect(result.closedTrades[0]!.grossPnL).toBeCloseTo(4);
  });

  it("closes a long position via trailing stop using peak tracking", () => {
    const trade = makeTrade({ direction: "long", entryPrice: 100, status: "open" });
    const candles = [
      makeCandle(1_050_000, 105, 104, 104),
      makeCandle(1_100_000, 105.5, 102, 103),
    ];
    const trailingScenario: RiskScenario = {
      name: "TrailingSynthetic",
      stopLossPct: 0,
      takeProfitPct: 0,
      positionSizePct: 100,
      maxExposurePct: 100,
      maxSimultaneousPositions: 10,
      transactionCostPct: 0,
      slippagePct: 0,
    };
    const result = simulateExits({
      openPositions: [trade],
      candlesByCanonical: new Map([["EURUSD", candles]]),
      config: { ...config, trailingStopPct: 2 },
      scenario: trailingScenario,
    });

    // peak = 105 (c1), then 105.5 (c2); trailing stop = 2% -> level = 105.5 * 0.98 = 103.39; c2 low 102 triggers
    expect(result.closedTrades[0]!.exitReason).toBe("trailing");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(103.39);
    expect(result.closedTrades[0]!.grossPnL).toBeCloseTo(3.39);
  });

  it("closes a long position via time-based exit at the candle close", () => {
    const trade = makeTrade({ direction: "long", entryTime: 1_000_000, entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_800_000, 101, 100.5, 100.8)];
    const result = simulateExits({
      openPositions: [trade],
      candlesByCanonical: new Map([["EURUSD", candles]]),
      config: { ...config, maxHoldingPeriodMs: 800_000 },
      scenario: baseline,
    });

    expect(result.closedTrades[0]!.exitReason).toBe("time");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(100.8);
    expect(result.closedTrades[0]!.holdingPeriodMs).toBe(800_000);
  });

  it("keeps a position open when no exit condition is met and marks to market", () => {
    const trade = makeTrade({ direction: "long", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 105, 104, 104)];
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: baseline });

    expect(result.closedTrades).toHaveLength(1);
    expect(result.closedTrades[0]!.exitReason).toBe("mark");
    expect(result.closedTrades[0]!.exitPrice).toBeCloseTo(104);
    expect(result.closedTrades[0]!.status).toBe("closed");
  });

  it("applies transaction costs and slippage to net PnL on exit", () => {
    const trade = makeTrade({ direction: "long", entryPrice: 100, status: "open" });
    const candles = [makeCandle(1_050_000, 99.5, 97.5, 98)]; // SL 2% -> exit 98, gross -2
    const result = simulateExits({ openPositions: [trade], candlesByCanonical: new Map([["EURUSD", candles]]), config, scenario: moderate });

    // moderate: tx 0.05% on entry, slippage 2% on entry
    const expectedNet = -2 - 100 * 0.0005 - 100 * 0.02;
    expect(result.closedTrades[0]!.netPnL).toBeCloseTo(expectedNet);
    expect(result.closedTrades[0]!.fees).toBeCloseTo(100 * 0.0005);
    expect(result.closedTrades[0]!.slippage).toBeCloseTo(100 * 0.02);
  });

  it("can open a position within exposure and simultaneous-position limits", () => {
    expect(canOpenPosition([], 100, 10_000, moderate)).toBe(true);
    const open = [makeTrade({ entryPrice: 100 }), makeTrade({ entryPrice: 100 }), makeTrade({ entryPrice: 100 })];
    expect(canOpenPosition(open, 100, 10_000, moderate)).toBe(false); // maxSimultaneousPositions = 3
    const highExposure = [makeTrade({ entryPrice: 3_000 }), makeTrade({ entryPrice: 3_000 })];
    expect(canOpenPosition(highExposure, 100, 10_000, moderate)).toBe(false); // exposure limit 50% of 10k = 5k
  });
});

describe("Backtester metrics (synthetic cases)", () => {
  it("computes max drawdown from the closed-trade equity curve", () => {
    const trades: TradeRecord[] = [
      makeTrade({ id: "t1", grossPnL: -50, netPnL: -50, status: "closed", exitTime: 1_000, exitReason: "target" }),
      makeTrade({ id: "t2", grossPnL: 60, netPnL: 60, status: "closed", exitTime: 2_000, exitReason: "target" }),
    ];
    const metrics = computeMetrics(trades, baseline);
    // equity: 10000 -> 9950 (drawdown 50/10000 = 0.005) -> 10010 (peak 10010); max drawdown = 0.005
    expect(metrics.maxDrawdown).toBeCloseTo(0.005);
  });
});
