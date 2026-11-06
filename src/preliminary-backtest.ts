/**
 * Preliminary Backtest — read-only staged strategy evaluation.
 *
 * Runs the frozen Phase 4 E2 backtest pipeline over an approved subset of
 * timeframes only. This is a preliminary pipeline validation run over historical
 * data. It must not be treated as a validated backtest, and no conclusion about
 * strategy robustness or profitability may be drawn from it yet.
 *
 * Approved staged subset (from the Phase 6 dataset-readiness decision):
 * - Primary:    5m, 15m, 30m
 * - Secondary: 1h
 * - Diagnostic: 4h
 * - Excluded (insufficient / non-evaluable data): 5h, 1d, 1w
 *
 * For each staged timeframe the script runs the frozen backtester (entry =
 * transition + frozen E2 waiting period, first available confirming candle;
 * exits = frozen stop-loss / take-profit / trailing-stop / time rules, then
 * end-of-data mark-to-market) and the frozen forward-return evaluation
 * (E1 immediate / E2 delayed theoretical entry) across the frozen horizons.
 *
 * Read-only: no writes, no persistence, no collector / signal logic changes.
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { runBacktest, RISK_SCENARIOS, verifyFrozenSpec, type StrategyConfig, type TradeRecord } from "./backtester";
import { evaluateTimeframe, type SignalEvaluationResult } from "./evaluation";
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

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function fmtTs(ts: number | null | undefined): string {
  const t = Number(ts ?? 0);
  if (!Number.isFinite(t) || t <= 0) return "-";
  return new Date(t).toISOString();
}

function fmtNum(value: number | null | undefined, digits = 6): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function printBacktestSection(title: string, result: Awaited<ReturnType<typeof runBacktest>>): void {
  const metrics = result.metrics;
  console.log(`  --- ${title} ---`);
  console.log(`    tradeCount=${metrics.tradeCount} openTrades=${metrics.openTrades} closedTrades=${metrics.tradeCount - metrics.openTrades}`);
  console.log(`    totalReturn=${fmtNum(metrics.totalReturn)} netProfit=${fmtNum(metrics.netProfit)} winRate=${fmtNum(metrics.winRate)} profitFactor=${fmtNum(metrics.profitFactor)} expectancy=${fmtNum(metrics.expectancy)} maxDrawdown=${fmtNum(metrics.maxDrawdown)}`);
  console.log(`    avgWin=${fmtNum(metrics.avgWin)} avgLoss=${fmtNum(metrics.avgLoss)} sharpe=${fmtNum(metrics.sharpeRatio)} sortino=${fmtNum(metrics.sortinoRatio)} exposure=${fmtNum(metrics.exposure)}`);

  const tradesBySymbol = new Map<string, TradeRecord[]>();
  for (const trade of result.trades) {
    const list = tradesBySymbol.get(trade.symbol) ?? [];
    list.push(trade);
    tradesBySymbol.set(trade.symbol, list);
  }

  const symbols = [...tradesBySymbol.keys()].sort();
  for (const symbol of symbols) {
    const list = tradesBySymbol.get(symbol) ?? [];
    const closed = list.filter((t) => t.status === "closed");
    const grossPnL = closed.reduce((sum, t) => sum + t.grossPnL, 0);
    const netPnL = closed.reduce((sum, t) => sum + t.netPnL, 0);
    const wins = closed.filter((t) => t.grossPnL > 0).length;
    console.log(`    symbol=${symbol} trades=${list.length} closed=${closed.length} winRate=${closed.length > 0 ? wins / closed.length : 0} grossPnL=${grossPnL} netPnL=${netPnL}`);
    for (const t of list) {
      console.log(`      ${t.direction} entry=${fmtTs(t.entryTime)} entryPrice=${t.entryPrice} exit=${fmtTs(t.exitTime)} exitPrice=${t.exitPrice} exitReason=${t.exitReason} grossPnL=${t.grossPnL} netPnL=${t.netPnL} fees=${t.fees} slippage=${t.slippage} holdingMs=${t.holdingPeriodMs} status=${t.status}`);
    }
  }
}

function printForwardReturns(evaluation: SignalEvaluationResult): void {
  console.log(`  evaluation timeframe=${evaluation.timeframe} totalTransitions=${evaluation.totalTransitions} freshTransitions=${evaluation.freshTransitions} directionalTransitions=${evaluation.directionalTransitions}`);

  for (const phase of ["e1", "e2"] as const) {
    const stats = evaluation[phase];
    for (const [signal, group] of Object.entries(stats.bySignal)) {
      const horizonParts: string[] = [];
      for (const horizon of ["1", "3", "6", "12", "24"]) {
        const h = group.horizons[horizon];
        if (!h) continue;
        horizonParts.push(`h=${horizon}: n=${h.n} meanRet=${fmtNum(h.meanRet)} median=${fmtNum(h.median)} min=${fmtNum(h.min)} max=${fmtNum(h.max)} hitRate=${fmtNum(h.hitRate)} mfeMean=${fmtNum(h.mfeMean)} maeMean=${fmtNum(h.maeMean)}`);
      }
      console.log(`    ${phase} signal=${signal} entries=${group.entries} ${horizonParts.join(" | ")}`);
    }
  }
}

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(DATABASE_PATH);
  const connection: DatabaseConnection = await instance.connect();

  console.log(`Database: ${DATABASE_PATH}`);

  for (const staged of STAGED_TIMEFRAMES) {
    const timeframe = staged.timeframe;
    console.log(`\n========== PRELIMINARY BACKTEST — ${timeframe} (stage=${staged.stage}) ==========`);

    const strategyConfig: StrategyConfig = {
      ...FROZEN_STRATEGY_CONFIG,
      mainTimeframe: timeframe,
    };
    console.log(`frozenSpecValid=${verifyFrozenSpec(strategyConfig)} entryDelayMs=${strategyConfig.entryDelayMs} directionalSignals=${strategyConfig.directionalSignals.join(",")} freshOnly=${strategyConfig.freshOnly}`);

    for (const [scenarioName, scenario] of Object.entries(RISK_SCENARIOS)) {
      const result = await runBacktest(connection, strategyConfig, scenario);
      await printBacktestSection(`scenario=${scenario.name}`, result);
    }

    const evaluation = await evaluateTimeframe(connection, timeframe);
    printForwardReturns(evaluation);
  }

  console.log("\n========== PRELIMINARY BACKTEST COMPLETED ==========");
}

main().catch((error) => {
  console.error("Preliminary backtest failed:", error);
  process.exitCode = 1;
});
