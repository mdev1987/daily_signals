/**
 * Preliminary Backtest Selection Audit — read-only.
 *
 * Explains why the preliminary backtest (`src/preliminary-backtest.ts`) produced
 * exactly 10 trades per timeframe, all on EURUSD, despite thousands of eligible
 * events in the historical sample.
 *
 * For each staged timeframe it replicates the frozen backtest entry selection
 * (fresh + directional transitions -> E2 entry delay -> first confirming candle
 * -> frozen position guards) and classifies every attempted event:
 *   - ACCEPTED          (passed position guards, became a trade)
 *   - REJECTED_NO_ENTRY (no confirming candle available in collected data)
 *   - REJECTED_CAP      (failed max-simultaneous-positions / exposure guard)
 *
 * Read-only: no writes, no persistence, no strategy / database changes.
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { canOpenPosition, RISK_SCENARIOS, verifyFrozenSpec, type RiskScenario, type StrategyConfig, type TradeRecord } from "./backtester";
import { alignTimeframe, resolveCanonicalSymbol, type AlignedSignal } from "./alignment";
import { computeTransitions, loadCandlesBySymbol, type EvaluationCandle } from "./evaluation";
import type { DatabaseConnection } from "./database";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/signals.duckdb";

type Stage = "primary" | "secondary" | "diagnostic";

interface StagedTimeframe {
  timeframe: string;
  stage: Stage;
}

const STAGED_TIMEFRAMES: StagedTimeframe[] = [
  { timeframe: "5m", stage: "primary" },
  { timeframe: "15m", stage: "primary" },
  { timeframe: "30m", stage: "primary" },
  { timeframe: "1h", stage: "secondary" },
  { timeframe: "4h", stage: "diagnostic" },
];

const FROZEN_STRATEGY_CONFIG: Omit<StrategyConfig, "mainTimeframe"> = {
  entryDelayMs: 300_000,
  directionalSignals: ["BUY", "STRONG_BUY", "SELL", "STRONG_SELL"],
  freshOnly: true,
};

interface SymbolOutcome {
  symbol: string;
  attempted: number;
  accepted: number;
  rejectedNoEntry: number;
  rejectedCap: number;
}

function fmtTs(ts: number | null | undefined): string {
  const t = Number(ts ?? 0);
  if (!Number.isFinite(t) || t <= 0) return "-";
  return new Date(t).toISOString();
}

function directionOf(signal: string): "long" | "short" {
  return signal === "BUY" || signal === "STRONG_BUY" ? "long" : "short";
}

async function runSelectionAudit(
  connection: DatabaseConnection,
  timeframe: string,
): Promise<{
  attempted: number;
  accepted: number;
  rejectedNoEntry: number;
  rejectedCap: number;
  executedSymbols: string[];
  outcomes: Map<string, SymbolOutcome>;
  executedTrades: TradeRecord[];
}> {
  const strategyConfig: StrategyConfig = {
    ...FROZEN_STRATEGY_CONFIG,
    mainTimeframe: timeframe,
  };
  const scenario = RISK_SCENARIOS.baseline as RiskScenario;

  const aligned: AlignedSignal[] = await alignTimeframe(connection, timeframe);
  const transitions = computeTransitions(timeframe, aligned).filter(
    (t) => t.fresh && strategyConfig.directionalSignals.includes(t.currentSignal),
  );

  const candlesBySymbol = await loadCandlesBySymbol(connection, timeframe);
  const buckets = new Map<string, EvaluationCandle[]>();
  for (const [symbol, list] of candlesBySymbol.entries()) {
    const canonical = await resolveCanonicalSymbol(symbol);
    const bucket = buckets.get(canonical) ?? [];
    for (const candle of list) bucket.push(candle);
    buckets.set(canonical, bucket);
  }

  let balance = 10000;
  const openPositions: TradeRecord[] = [];
  const executedTrades: TradeRecord[] = [];
  const outcomes = new Map<string, SymbolOutcome>();

  const outcomeFor = (symbol: string): SymbolOutcome => {
    const existing = outcomes.get(symbol);
    if (existing) return existing;
    const created: SymbolOutcome = { symbol, attempted: 0, accepted: 0, rejectedNoEntry: 0, rejectedCap: 0 };
    outcomes.set(symbol, created);
    return created;
  };

  let rejectedNoEntryCount = 0;
  let rejectedCapCount = 0;

  for (const transition of transitions) {
    const symbol = await resolveCanonicalSymbol(transition.symbol);
    const candles = buckets.get(symbol) ?? [];
    const outcome = outcomeFor(symbol);
    outcome.attempted += 1;

    const waitEnd = transition.observedAt + strategyConfig.entryDelayMs;
    const entryCandle = candles.find((c) => c.closeTime > waitEnd);

    if (!entryCandle) {
      outcome.rejectedNoEntry += 1;
      rejectedNoEntryCount += 1;
      continue;
    }

    const entryPrice = entryCandle.close;
    const direction = directionOf(transition.currentSignal);

    if (!canOpenPosition(openPositions, entryPrice, balance, scenario)) {
      outcome.rejectedCap += 1;
      rejectedCapCount += 1;
      continue;
    }

    const trade: TradeRecord = {
      id: crypto.randomUUID(),
      symbol,
      direction,
      entryTime: entryCandle.closeTime,
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
    executedTrades.push(trade);
    outcome.accepted += 1;
  }

  const executedSymbols = [...outcomes.entries()]
    .filter(([, o]) => o.accepted > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol]) => symbol);

  return {
    attempted: transitions.length,
    accepted: executedTrades.length,
    rejectedNoEntry: rejectedNoEntryCount,
    rejectedCap: rejectedCapCount,
    executedSymbols,
    outcomes,
    executedTrades,
  };
}

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(DATABASE_PATH);
  const connection: DatabaseConnection = await instance.connect();

  console.log(`Database: ${DATABASE_PATH}`);

  for (const staged of STAGED_TIMEFRAMES) {
    const timeframe = staged.timeframe;
    console.log(`\n========== PRELIMINARY BACKTEST SELECTION AUDIT — ${timeframe} (stage=${staged.stage}) ==========`);

    const strategyConfig: StrategyConfig = {
      ...FROZEN_STRATEGY_CONFIG,
      mainTimeframe: timeframe,
    };
    const frozenSpecValid = verifyFrozenSpec(strategyConfig);

    const executed = await runSelectionAudit(connection, timeframe);

    console.log(`  frozenSpecValid=${frozenSpecValid} entryDelayMs=${strategyConfig.entryDelayMs} freshOnly=${strategyConfig.freshOnly}`);
    console.log(`  attempted(fresh+directional)=${executed.attempted}`);
    console.log(`  executedAccepted=${executed.accepted}`);
    console.log(`  rejectedNoEntry=${executed.rejectedNoEntry}`);
    console.log(`  rejectedByPositionGuards=${executed.rejectedCap}`);
    console.log(`  executedSymbols=[${executed.executedSymbols.join(", ")}]`);

    const outcomeEntries = [...executed.outcomes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [symbol, o] of outcomeEntries) {
      console.log(`    OUTCOME symbol=${symbol} attempted=${o.attempted} accepted=${o.accepted} rejectedNoEntry=${o.rejectedNoEntry} rejectedCap=${o.rejectedCap}`);
    }

    console.log(`  executed trades (baseline selection):`);
    for (const t of executed.executedTrades) {
      console.log(`    ${t.direction} symbol=${t.symbol} entry=${fmtTs(t.entryTime)} entryPrice=${t.entryPrice} status=${t.status}`);
    }
  }

  console.log("\n========== PRELIMINARY BACKTEST SELECTION AUDIT COMPLETED ==========");
}

main().catch((error) => {
  console.error("Preliminary backtest selection audit failed:", error);
  process.exitCode = 1;
});
