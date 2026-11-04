/**
 * E4: Multi-Timeframe State Evaluation
 * 
 * Implements the provider's documented multi-timeframe exit monitoring strategy.
 * Evaluates whether lower-timeframe signal combinations provide useful information
 * about the continuation or reversal of a higher-timeframe position.
 * 
 * Based on the documented 1h SELL example:
 * | 5m | 15m | 30m | State | Interpretation |
 * |---|---|---|---|---|
 * | SELL | SELL | SELL | Entry | Enter SELL |
 * | BUY | SELL | SELL | NORMAL | Keep SELL |
 * | BUY | BUY | SELL | WAIT | Market may be changing |
 * | SELL | BUY | SELL | AGAIN | Market is in SELL direction |
 * | BUY | BUY | BUY | ALERT | Close SELL |
 */

import type { DatabaseConnection } from "./database";
import { alignTimeframe, type AlignedSignal } from "./alignment";
import { computeTransitions, type SignalTransition } from "./evaluation";
import { loadCandlesBySymbol, type EvaluationCandle } from "./evaluation";
import { resolveCanonicalSymbol } from "./alignment";

/**
 * E4 State definitions (preserving provider's original terminology)
 */
export type E4State = "Entry" | "Normal" | "Wait" | "Again" | "Alert" | "Unknown";

/**
 * E4 State transition record
 */
export interface E4Transition {
  symbol: string;
  mainTimeframe: string;
  lowerTimeframes: string[];
  timestamp: number;
  previousState: E4State | null;
  currentState: E4State;
  lowerSignals: {
    "5m": string | null;
    "15m": string | null;
    "30m": string | null;
  };
  mainSignal: string;
}

/**
 * Forward return analysis for an E4 state
 */
export interface E4ForwardReturn {
  state: E4State;
  symbol: string;
  mainTimeframe: string;
  entryTime: number;
  entryPrice: number;
  horizon: number;
  return: number;
  mfe: number;
  mae: number;
}

/**
 * E4 evaluation result for a main timeframe
 */
export interface E4EvaluationResult {
  mainTimeframe: string;
  totalPositions: number;
  stateTransitions: E4Transition[];
  forwardReturns: E4ForwardReturn[];
  stateStats: Record<E4State, {
    count: number;
    meanReturn: number;
    medianReturn: number;
    hitRate: number;
    mfeMean: number;
    maeMean: number;
  }>;
}

/**
 * Lower-timeframe signal combination for state determination
 */
interface LowerSignals {
  "5m": string | null;
  "15m": string | null;
  "30m": string | null;
}

/**
 * Index of signals by symbol, sorted by timestamp
 */
interface SignalIndex {
  [symbol: string]: AlignedSignal[];
}

/**
 * Builds a symbol-indexed lookup from aligned signals
 */
function buildSignalIndex(aligned: AlignedSignal[]): SignalIndex {
  const index: SignalIndex = {};
  for (const a of aligned) {
    const list = index[a.symbol] ?? [];
    list.push(a);
    index[a.symbol] = list;
  }
  for (const list of Object.values(index)) {
    list.sort((a, b) => a.observed_at - b.observed_at);
  }
  return index;
}

/**
 * Gets the latest signal for a symbol at or before a given timestamp
 * using binary search on the pre-sorted index
 */
function getSignalAtTime(
  index: SignalIndex | undefined,
  symbol: string,
  timestamp: number
): string | null {
  if (!index) return null;
  const list = index[symbol];
  if (!list || list.length === 0) return null;

  // Binary search for latest signal at or before timestamp
  let lo = 0;
  let hi = list.length - 1;
  let result: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const signal = list[mid];
    if (signal && signal.observed_at <= timestamp) {
      result = signal.signal;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

/**
 * Determines E4 state from lower-timeframe signals (SELL-side example)
 * 
 * Only implements documented combinations. Unknown combinations return "Unknown".
 * BUY-side behavior is NOT assumed to be symmetrical.
 */
function determineE4StateSell(lower: LowerSignals): E4State {
  const s5 = lower["5m"];
  const s15 = lower["15m"];
  const s30 = lower["30m"];

  // Documented combinations for SELL position
  if (s5 === "SELL" && s15 === "SELL" && s30 === "SELL") return "Entry";
  if (s5 === "BUY" && s15 === "SELL" && s30 === "SELL") return "Normal";
  if (s5 === "BUY" && s15 === "BUY" && s30 === "SELL") return "Wait";
  if (s5 === "SELL" && s15 === "BUY" && s30 === "SELL") return "Again";
  if (s5 === "BUY" && s15 === "BUY" && s30 === "BUY") return "Alert";

  return "Unknown";
}

/**
 * Determines E4 state from lower-timeframe signals (BUY-side - NOT documented)
 * 
 * Returns "Unknown" for all combinations since provider only documented SELL example.
 * This prevents assuming symmetrical behavior.
 */
function determineE4StateBuy(_lower: LowerSignals): E4State {
  // Provider only documented SELL example. Do not assume symmetry.
  return "Unknown";
}

/**
 * Reconstructs historical E4 states for a main timeframe position
 * Optimized: pre-indexes signals by symbol for fast lookup
 */
async function reconstructE4States(
  mainAligned: AlignedSignal[],
  lowerIndices: Record<string, SignalIndex>,
  mainTimeframe: string,
  lowerTimeframes: string[]
): Promise<E4Transition[]> {
  // Get main timeframe transitions (position entries/exits)
  const mainTransitions = computeTransitions(mainTimeframe, mainAligned)
    .filter(t => t.fresh && (t.currentSignal === "SELL" || t.currentSignal === "STRONG_SELL"));

  const transitions: E4Transition[] = [];

  for (const mainTrans of mainTransitions) {
    // Get lower timeframe signals at the moment of main transition
    const lowerSignals: LowerSignals = {
      "5m": getSignalAtTime(lowerIndices["5m"]!, mainTrans.symbol, mainTrans.observedAt),
      "15m": getSignalAtTime(lowerIndices["15m"]!, mainTrans.symbol, mainTrans.observedAt),
      "30m": getSignalAtTime(lowerIndices["30m"]!, mainTrans.symbol, mainTrans.observedAt),
    };

    // Determine initial state
    let currentState: E4State;
    if (mainTrans.currentSignal === "SELL" || mainTrans.currentSignal === "STRONG_SELL") {
      currentState = determineE4StateSell(lowerSignals);
    } else {
      currentState = determineE4StateBuy(lowerSignals);
    }

    // Record initial state
    transitions.push({
      symbol: mainTrans.symbol,
      mainTimeframe,
      lowerTimeframes,
      timestamp: mainTrans.observedAt,
      previousState: null,
      currentState,
      lowerSignals,
      mainSignal: mainTrans.currentSignal,
    });

    // Track state changes over time while position is open
    // Find subsequent lower timeframe signal changes
    const allLowerTimes = new Set<number>();
    for (const tf of lowerTimeframes) {
      const index = lowerIndices[tf];
      const list = index?.[mainTrans.symbol];
      if (index && list) {
        for (const a of list) {
          if (a.observed_at > mainTrans.observedAt) {
            allLowerTimes.add(a.observed_at);
          }
        }
      }
    }

    const sortedTimes = [...allLowerTimes].sort((a, b) => a - b);
    let lastState = currentState;

    for (const t of sortedTimes) {
      const newLowerSignals: LowerSignals = {
        "5m": getSignalAtTime(lowerIndices["5m"]!, mainTrans.symbol, t),
        "15m": getSignalAtTime(lowerIndices["15m"]!, mainTrans.symbol, t),
        "30m": getSignalAtTime(lowerIndices["30m"]!, mainTrans.symbol, t),
      };

      let newState: E4State;
      if (mainTrans.currentSignal === "SELL" || mainTrans.currentSignal === "STRONG_SELL") {
        newState = determineE4StateSell(newLowerSignals);
      } else {
        newState = determineE4StateBuy(newLowerSignals);
      }

      if (newState !== lastState && newState !== "Unknown") {
        transitions.push({
          symbol: mainTrans.symbol,
          mainTimeframe,
          lowerTimeframes,
          timestamp: t,
          previousState: lastState,
          currentState: newState,
          lowerSignals: newLowerSignals,
          mainSignal: mainTrans.currentSignal,
        });
        lastState = newState;
      }

      // Stop tracking if ALERT (close signal) or position would be closed
      if (newState === "Alert") break;
    }
  }

  return transitions;
}

/**
 * Computes forward returns for E4 state transitions
 */
async function computeE4ForwardReturns(
  transitions: E4Transition[],
  mainTimeframe: string,
  horizons: number[],
  candlesByCanonical: Map<string, EvaluationCandle[]>
): Promise<E4ForwardReturn[]> {
  const returns: E4ForwardReturn[] = [];

  for (const trans of transitions) {
    const canonicalSymbol = await resolveCanonicalSymbol(trans.symbol);
    const candles = candlesByCanonical.get(canonicalSymbol) ?? [];
    
    // Find entry candle (first candle after transition timestamp)
    const entryCandle = candles.find(c => c.closeTime > trans.timestamp);
    if (!entryCandle) continue;

    const entryPrice = entryCandle.close;
    const entryTime = entryCandle.closeTime;

    // Determine if bullish or bearish
    const isBearish = trans.mainSignal === "SELL" || trans.mainSignal === "STRONG_SELL";

    for (const horizon of horizons) {
      const future = candles.filter(c => c.closeTime > entryTime);
      const target = future[horizon - 1];
      if (!target) continue;

      const ret = isBearish
        ? (entryPrice - target.close) / entryPrice
        : (target.close - entryPrice) / entryPrice;

      // Calculate MFE/MAE
      let mfe = Number.NEGATIVE_INFINITY;
      let mae = Number.NEGATIVE_INFINITY;

      for (let j = 0; j < horizon && j < future.length; j++) {
        const candle = future[j];
        if (!candle) break;
        const favorableUp = (candle.high - entryPrice) / entryPrice;
        const favorableDown = (entryPrice - candle.low) / entryPrice;
        const up = isBearish ? favorableDown : favorableUp;
        const down = isBearish ? favorableUp : favorableDown;
        if (up > mfe) mfe = up;
        if (down > mae) mae = down;
      }

      returns.push({
        state: trans.currentState,
        symbol: trans.symbol,
        mainTimeframe: trans.mainTimeframe,
        entryTime,
        entryPrice,
        horizon,
        return: ret,
        mfe: mfe === Number.NEGATIVE_INFINITY ? 0 : mfe,
        mae: mae === Number.NEGATIVE_INFINITY ? 0 : mae,
      });
    }
  }

  return returns;
}

/**
 * Aggregates forward return statistics by E4 state
 */
function aggregateE4Stats(
  returns: E4ForwardReturn[],
  horizons: number[]
): E4EvaluationResult["stateStats"] {
  const stats: E4EvaluationResult["stateStats"] = {
    Entry: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
    Normal: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
    Wait: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
    Again: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
    Alert: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
    Unknown: { count: 0, meanReturn: 0, medianReturn: 0, hitRate: 0, mfeMean: 0, maeMean: 0 },
  };

  for (const horizon of horizons) {
    const byState = new Map<E4State, E4ForwardReturn[]>();
    
    for (const r of returns) {
      if (r.horizon === horizon) {
        const list = byState.get(r.state) ?? [];
        list.push(r);
        byState.set(r.state, list);
      }
    }

    for (const [state, stateReturns] of byState.entries()) {
      if (stateReturns.length === 0) continue;
      
      const rets = stateReturns.map(r => r.return);
      const mfes = stateReturns.map(r => r.mfe);
      const maes = stateReturns.map(r => r.mae);
      
      const sorted = [...rets].sort((a, b) => a - b);
      const median = sorted.length % 2 === 1
        ? sorted[Math.floor(sorted.length / 2)] ?? 0
        : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
      
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const hitRate = rets.filter(r => r > 0).length / rets.length;
      const mfeMean = mfes.reduce((a, b) => a + b, 0) / mfes.length;
      const maeMean = maes.reduce((a, b) => a + b, 0) / maes.length;

      // Accumulate (simple average across horizons for now)
      stats[state].count += stateReturns.length;
      stats[state].meanReturn += mean;
      stats[state].medianReturn += median;
      stats[state].hitRate += hitRate;
      stats[state].mfeMean += mfeMean;
      stats[state].maeMean += maeMean;
    }
  }

  // Average across horizons
  const numHorizons = horizons.length;
  for (const state of Object.keys(stats) as E4State[]) {
    if (stats[state].count > 0) {
      stats[state].meanReturn /= numHorizons;
      stats[state].medianReturn /= numHorizons;
      stats[state].hitRate /= numHorizons;
      stats[state].mfeMean /= numHorizons;
      stats[state].maeMean /= numHorizons;
    }
  }

  return stats;
}

/**
 * Main E4 evaluation function
 * 
 * Evaluates the multi-timeframe state machine for a given main timeframe.
 * Currently only implements the documented SELL-side example.
 */
export async function evaluateE4(
  connection: DatabaseConnection,
  mainTimeframe: string,
  lowerTimeframes: string[] = ["5m", "15m", "30m"],
  horizons: number[] = [1, 3, 6, 12, 24]
): Promise<E4EvaluationResult> {
  console.log(`Evaluating E4 for main timeframe: ${mainTimeframe}`);
  
  // Align all timeframes (load all data once)
  const mainAligned = await alignTimeframe(connection, mainTimeframe);
  console.log(`  Loaded ${mainAligned.length} main timeframe snapshots`);
  
  const lowerIndices: Record<string, SignalIndex> = {};
  for (const tf of lowerTimeframes) {
    const aligned = await alignTimeframe(connection, tf);
    lowerIndices[tf] = buildSignalIndex(aligned);
    console.log(`  Loaded ${aligned.length} ${tf} snapshots`);
  }

  // Reconstruct historical states
  const transitions = await reconstructE4States(
    mainAligned, lowerIndices, mainTimeframe, lowerTimeframes
  );
  console.log(`  Found ${transitions.length} state transitions`);
  
  // Load candles for main timeframe (canonical symbols)
  const candlesBySymbol = await loadCandlesBySymbol(connection, mainTimeframe);
  const candlesByCanonical = new Map<string, EvaluationCandle[]>();
  
  for (const [symbol, list] of candlesBySymbol.entries()) {
    const canonical = await resolveCanonicalSymbol(symbol);
    const bucket = candlesByCanonical.get(canonical) ?? [];
    for (const candle of list) bucket.push(candle);
    candlesByCanonical.set(canonical, bucket);
  }
  
  console.log(`  Loaded candles for ${candlesByCanonical.size} canonical symbols`);

  // Compute forward returns
  const forwardReturns = await computeE4ForwardReturns(
    transitions, mainTimeframe, horizons, candlesByCanonical
  );
  console.log(`  Computed ${forwardReturns.length} forward return samples`);
  
  // Aggregate statistics
  const stateStats = aggregateE4Stats(forwardReturns, horizons);
  
  // Count unique positions (Entry states)
  const totalPositions = transitions.filter(t => t.currentState === "Entry").length;
  
  return {
    mainTimeframe,
    totalPositions,
    stateTransitions: transitions,
    forwardReturns,
    stateStats,
  };
}

/**
 * Runs E4 evaluation for all supported main timeframes
 */
export async function runE4Evaluation(
  connection: DatabaseConnection,
  mainTimeframes: string[] = ["1h", "4h", "1d"]
): Promise<E4EvaluationResult[]> {
  const results: E4EvaluationResult[] = [];
  
  for (const tf of mainTimeframes) {
    try {
      const result = await evaluateE4(connection, tf);
      results.push(result);
    } catch (error) {
      console.error(`Error evaluating E4 for ${tf}:`, error);
    }
  }
  
  return results;
}