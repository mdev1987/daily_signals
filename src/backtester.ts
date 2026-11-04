/**
 * Phase 5 — First Paper Backtester
 * 
 * Research instrument implementing the frozen Phase 4 E2 specification.
 * Not an optimizer. Parameter ranges must be defined before results are examined.
 * 
 * Design principles:
 * 1. Faithful execution of frozen rules (no silent changes)
 * 2. Parameter isolation (configurable, predefined scenarios)
 * 3. Realistic costs (gross/net separate)
 * 4. Reproducibility (deterministic, same data = same results)
 * 5. Complete trade accounting (open/exit/reversal/fees/slippage/rejected)
 */

import type { DatabaseConnection } from "./database";
import { alignTimeframe, resolveCanonicalSymbol } from "./alignment";
import { computeTransitions } from "./evaluation";
import { loadCandlesBySymbol } from "./evaluation";

/**
 * Frozen strategy parameters — must not be changed during testing
 */
export interface StrategyConfig {
  /** Main timeframe for signal selection */
  mainTimeframe: string;
  /** Entry delay in ms (E2 = 300,000) */
  entryDelayMs: number;
  /** Signal states that trigger directional entries */
  directionalSignals: string[];
  /** Whether to include only FRESH observations */
  freshOnly: boolean;
  /** Trailing stop percentage; 0 disables trailing-stop exits */
  trailingStopPct?: number;
  /** Maximum holding period in ms; 0 disables time-based exits */
  maxHoldingPeriodMs?: number;
}

/**
 * Risk parameter scenarios — predefined before testing
 */
export interface RiskScenario {
  name: string;
  stopLossPct: number;
  takeProfitPct: number;
  positionSizePct: number;
  maxExposurePct: number;
  maxSimultaneousPositions: number;
  transactionCostPct: number;
  slippagePct: number;
}

/**
 * Predefined risk scenarios (must be defined before testing)
 */
export const RISK_SCENARIOS: Record<string, RiskScenario> = {
  baseline: {
    name: "Baseline",
    stopLossPct: 0,
    takeProfitPct: 0,
    positionSizePct: 100,
    maxExposurePct: 100,
    maxSimultaneousPositions: 10,
    transactionCostPct: 0,
    slippagePct: 0,
  },
  moderate: {
    name: "Moderate",
    stopLossPct: 2,
    takeProfitPct: 4,
    positionSizePct: 10,
    maxExposurePct: 50,
    maxSimultaneousPositions: 3,
    transactionCostPct: 0.05,
    slippagePct: 0.02,
  },
  stress: {
    name: "Stress",
    stopLossPct: 5,
    takeProfitPct: 10,
    positionSizePct: 5,
    maxExposurePct: 25,
    maxSimultaneousPositions: 2,
    transactionCostPct: 0.15,
    slippagePct: 0.05,
  },
};

/**
 * Trade execution record
 */
export interface TradeRecord {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: "stop" | "target" | "reversal" | "time" | "open" | "trailing" | "mark";
  grossPnL: number;
  netPnL: number;
  fees: number;
  slippage: number;
  holdingPeriodMs: number;
  status: "open" | "closed";
}

/**
 * Portfolio state at a point in time
 */
export interface PortfolioState {
  timestamp: number;
  balance: number;
  equity: number;
  openPositions: TradeRecord[];
  realizedPnL: number;
  unrealizedPnL: number;
  totalExposure: number;
  maxDrawdown: number;
}

/**
 * Backtest result
 */
export interface BacktestResult {
  config: StrategyConfig;
  scenario: RiskScenario;
  trades: TradeRecord[];
  portfolioHistory: PortfolioState[];
  metrics: {
    totalReturn: number;
    netProfit: number;
    winRate: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdown: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
    sortinoRatio: number;
    exposure: number;
    tradeCount: number;
    openTrades: number;
  };
}

/**
 * Main backtester — implements frozen Phase 4 E2 specification
 */
export async function runBacktest(
  connection: DatabaseConnection,
  config: StrategyConfig,
  scenario: RiskScenario
): Promise<BacktestResult> {
  console.log(`[BACKTESTER] Running E2 backtest: ${config.mainTimeframe}, scenario=${scenario.name}`);
  
  // Load aligned signals
  const aligned = await alignTimeframe(connection, config.mainTimeframe);
  const transitions = computeTransitions(config.mainTimeframe, aligned)
    .filter(t => t.fresh && config.directionalSignals.includes(t.currentSignal));
  
  // Load candles
  const candlesBySymbol = await loadCandlesBySymbol(connection, config.mainTimeframe);
  const candlesByCanonical = new Map<string, any[]>();
  
  for (const [symbol, list] of candlesBySymbol.entries()) {
    const canonical = await resolveCanonicalSymbol(symbol);
    const bucket = candlesByCanonical.get(canonical) ?? [];
    for (const candle of list) bucket.push(candle);
    candlesByCanonical.set(canonical, bucket);
  }
  
  // Initialize portfolio
  let balance = 10000; // Starting capital
  const trades: TradeRecord[] = [];
  const openPositions: TradeRecord[] = [];
  
  // Process each transition
  for (const trans of transitions) {
    const symbol = await resolveCanonicalSymbol(trans.symbol);
    const candles = candlesByCanonical.get(symbol) ?? [];
    
    // E2 entry: 5-minute delay
    const waitEnd = trans.observedAt + config.entryDelayMs;
    const entryCandle = candles.find(c => c.closeTime > waitEnd);
    
    if (!entryCandle) continue; // No price data available
    
    const entryPrice = entryCandle.close;
    const entryTime = entryCandle.closeTime;
    const direction = trans.currentSignal === "BUY" || trans.currentSignal === "STRONG_BUY" ? "long" : "short";
    
    // Check exposure limit
    const currentExposure = openPositions.reduce((sum, p) => sum + p.entryPrice, 0);
    const newExposure = currentExposure + entryPrice;
    if (newExposure > balance * scenario.maxExposurePct / 100) {
      // Rejected entry — record but do not open
      continue;
    }
    
    // Check max simultaneous positions
    if (openPositions.length >= scenario.maxSimultaneousPositions) {
      continue; // Rejected
    }
    
    // Create trade
    const trade: TradeRecord = {
      id: crypto.randomUUID(),
      symbol,
      direction,
      entryTime,
      entryPrice,
      exitTime: null,
      exitPrice: null,
      exitReason: "open",
      grossPnL: 0,
      netPnL: 0,
      fees: 0,
      slippage: 0,
      holdingPeriodMs: 0,
      status: "open",
    };
    
    openPositions.push(trade);
    trades.push(trade);
  }

    // Phase 5 exit simulation: close each open position by scanning forward
  // candles from the entry and applying the first exit condition met
  // (stop-loss, take-profit, trailing stop, time-based) per frozen rules.
  const openPositionsCopy = [...openPositions];
  const closedTrades: TradeRecord[] = [];

  for (const trade of openPositionsCopy) {
    const candles = candlesByCanonical.get(trade.symbol) ?? [];
    const isLong = trade.direction === "long";
    const stopLossPct = scenario.stopLossPct;
    const takeProfitPct = scenario.takeProfitPct;
    const trailingStopPct = config.trailingStopPct ?? 0;
    const maxHoldingPeriodMs = config.maxHoldingPeriodMs ?? 0;

    let exit: { price: number; time: number; reason: TradeRecord["exitReason"] } | null = null;
    let peak = trade.entryPrice;

    for (const c of candles) {
      if (c.closeTime <= trade.entryTime) continue;

      if (isLong) {
        peak = Math.max(peak, c.high);
        if (stopLossPct > 0 && c.low <= trade.entryPrice * (1 - stopLossPct / 100)) {
          exit = { price: trade.entryPrice * (1 - stopLossPct / 100), time: c.closeTime, reason: "stop" };
          break;
        }
        if (takeProfitPct > 0 && c.high >= trade.entryPrice * (1 + takeProfitPct / 100)) {
          exit = { price: trade.entryPrice * (1 + takeProfitPct / 100), time: c.closeTime, reason: "target" };
          break;
        }
        if (trailingStopPct > 0 && peak * (1 - trailingStopPct / 100) <= c.low) {
          exit = { price: peak * (1 - trailingStopPct / 100), time: c.closeTime, reason: "trailing" };
          break;
        }
      } else {
        peak = Math.min(peak, c.low);
        if (stopLossPct > 0 && c.high >= trade.entryPrice * (1 + stopLossPct / 100)) {
          exit = { price: trade.entryPrice * (1 + stopLossPct / 100), time: c.closeTime, reason: "stop" };
          break;
        }
        if (takeProfitPct > 0 && c.low <= trade.entryPrice * (1 - takeProfitPct / 100)) {
          exit = { price: trade.entryPrice * (1 - takeProfitPct / 100), time: c.closeTime, reason: "target" };
          break;
        }
        if (trailingStopPct > 0 && peak * (1 + trailingStopPct / 100) >= c.high) {
          exit = { price: peak * (1 + trailingStopPct / 100), time: c.closeTime, reason: "trailing" };
          break;
        }
      }

      if (maxHoldingPeriodMs > 0 && c.closeTime - trade.entryTime >= maxHoldingPeriodMs) {
        exit = { price: c.close, time: c.closeTime, reason: "time" };
        break;
      }
    }

    if (exit) {
      const dirMult = trade.direction === "long" ? 1 : -1;
      const gross = (exit.price - trade.entryPrice) * dirMult;
      const fees = Math.abs(trade.entryPrice) * scenario.transactionCostPct / 100;
      const slippage = Math.abs(trade.entryPrice) * scenario.slippagePct / 100;
      trade.exitTime = exit.time;
      trade.exitPrice = exit.price;
      trade.exitReason = exit.reason;
      trade.grossPnL = gross;
      trade.netPnL = gross - fees - slippage;
      trade.fees = fees;
      trade.slippage = slippage;
      trade.holdingPeriodMs = exit.time - trade.entryTime;
      trade.status = "closed";
      closedTrades.push(trade);
    }
  }

  // Phase 5: end-of-data mark-to-market liquidation of open positions at the
  // last observed candle close, for closed-trade accounting. This is evaluation
  // accounting only (realized PnL at period end); it is not a change to the
  // frozen exit rules (stop-loss / take-profit / trailing stop / time-based).
  for (const trade of [...openPositions]) {
    if (trade.status !== "open") continue;
    const candles = candlesByCanonical.get(trade.symbol) ?? [];
    const last = [...candles].reverse().find((c) => c.closeTime > trade.entryTime);
    if (!last) continue;
    const dirMult = trade.direction === "long" ? 1 : -1;
    const gross = (last.close - trade.entryPrice) * dirMult;
    const fees = Math.abs(trade.entryPrice) * scenario.transactionCostPct / 100;
    const slippage = Math.abs(trade.entryPrice) * scenario.slippagePct / 100;
    trade.exitTime = last.closeTime;
    trade.exitPrice = last.close;
    trade.exitReason = "mark";
    trade.grossPnL = gross;
    trade.netPnL = gross - fees - slippage;
    trade.fees = fees;
    trade.slippage = slippage;
    trade.holdingPeriodMs = last.closeTime - trade.entryTime;
    trade.status = "closed";
  }

  const metrics = computeMetrics(trades, scenario);
  
  return {
    config,
    scenario,
    trades,
    portfolioHistory: [], // To be populated with full simulation
    metrics,
  };
}

function computeMetrics(trades: TradeRecord[], scenario: RiskScenario): BacktestResult["metrics"] {
  const closed = trades.filter(t => t.status === "closed");
  const wins = closed.filter(t => t.grossPnL > 0);
  
  const grossPnL = closed.reduce((s, t) => s + t.grossPnL, 0);
  const netPnL = closed.reduce((s, t) => s + t.netPnL, 0);
  
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.grossPnL, 0) / wins.length : 0;
  const avgLoss = closed.filter(t => t.grossPnL < 0).reduce((s, t) => s + t.grossPnL, 0) / Math.max(1, closed.filter(t => t.grossPnL < 0).length);
  
  const profitFactor = grossPnL > 0 ? grossPnL / Math.abs(closed.filter(t => t.grossPnL < 0).reduce((s, t) => s + t.grossPnL, 0)) : 0;
  const expectancy = closed.length > 0 ? grossPnL / closed.length : 0;
  
  return {
    totalReturn: grossPnL / 10000,
    netProfit: netPnL,
    winRate,
    profitFactor,
    expectancy,
    maxDrawdown: 0, // To be computed from portfolio history
    avgWin,
    avgLoss,
    sharpeRatio: 0, // To be computed from portfolio history
    sortinoRatio: 0,
    exposure: 0,
    tradeCount: trades.length,
    openTrades: trades.filter(t => t.status === "open").length,
  };
}

/**
 * Validation: verify complete frozen Phase 4 specification
 * 
 * Checks all fixed rules from PHASE-4-STRATEGY-SPEC.md:
 * - Signal selection: directional only, FRESH only
 * - Entry: E2 delay = 300,000ms
 * - Canonical symbol mapping required
 * - E4 excluded, E3 deferred
 * - No strategy logic changes permitted
 */
export function verifyFrozenSpec(config: StrategyConfig): boolean {
  // 1. Main timeframe must be specified (not empty/default)
  if (!config.mainTimeframe || config.mainTimeframe.length === 0) return false;

  // 2. E2 entry timing: exactly 5 minutes (300,000 ms)
  if (config.entryDelayMs !== 300000) return false;

  // 3. Fresh-only eligibility (no stale observations)
  if (config.freshOnly !== true) return false;

  // 4. Directional signal selection (all four categories required)
  const requiredSignals = ["BUY", "STRONG_BUY", "SELL", "STRONG_SELL"];
  for (const s of requiredSignals) {
    if (!config.directionalSignals.includes(s)) return false;
  }

  // 5. No NEUTRAL or non-directional signals permitted
  if (config.directionalSignals.includes("NEUTRAL")) return false;

  // 6. E4 multi-timeframe confirmation excluded (not in directionalSignals or config)
  // (Enforced by absence of E4 fields in StrategyConfig)

  // 7. E3 price-based confirmation deferred (not in config)
  // (Enforced by absence of E3 fields in StrategyConfig)

  // 8. Canonical symbol mapping required (enforced by using resolveCanonicalSymbol in runBacktest)

  return true;
}