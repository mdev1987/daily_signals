import { withSerializedDatabaseOperation, type DatabaseConnection, type SignalChange } from "./database";
import type { SignalType } from "./parser";
import { resolveCanonicalSymbol } from "./alignment";

/** Phase 7 operational rules: 1h/5h/1d are entry timeframes; 5m/15m/30m are monitors only. */
export const PHASE7_CONFIG = {
  startingBalance: Number(process.env.PAPER_STARTING_BALANCE ?? 10_000),
  durationMs: 7 * 24 * 60 * 60 * 1_000,
  primaryTimeframes: ["1h", "5h", "1d"] as const,
  monitorTimeframes: ["5m", "15m", "30m"] as const,
  entryConfirmationMs: 5 * 60 * 1_000,
  priceTimeframe: "5m",
  maxPriceAgeMs: 15 * 60 * 1_000,
  positionSizePct: 10,
  maxExposurePct: 50,
  maxOpenPositions: 3,
  stopLossPct: 2,
  takeProfitPct: 4,
  feePctPerSide: 0.05,
  slippagePctPerSide: 0.02,
} as const;

type Direction = "long" | "short";
type DbRow = Record<string, unknown>;

export function signalDirection(signal: string): Direction | null {
  if (signal === "BUY" || signal === "STRONG_BUY") return "long";
  if (signal === "SELL" || signal === "STRONG_SELL") return "short";
  return null;
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

async function rows(connection: DatabaseConnection, sql: string, params: any[] = []): Promise<DbRow[]> {
  const result = await connection.runAndReadAll(sql, params);
  return result.getRowObjects() as unknown as DbRow[];
}

async function initializePaperTradingUnlocked(connection: DatabaseConnection): Promise<void> {
  if (!Number.isFinite(PHASE7_CONFIG.startingBalance) || PHASE7_CONFIG.startingBalance <= 0) {
    throw new Error("PAPER_STARTING_BALANCE must be a finite positive number");
  }

  await connection.run(`
    CREATE TABLE IF NOT EXISTS phase7_state (
      key VARCHAR PRIMARY KEY,
      value VARCHAR NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper_pending_entries (
      symbol VARCHAR NOT NULL,
      primary_timeframe VARCHAR NOT NULL,
      direction VARCHAR NOT NULL,
      signal VARCHAR NOT NULL,
      signal_since BIGINT NOT NULL,
      PRIMARY KEY (symbol, primary_timeframe)
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper_positions (
      id VARCHAR PRIMARY KEY,
      symbol VARCHAR NOT NULL,
      primary_timeframe VARCHAR NOT NULL,
      direction VARCHAR NOT NULL,
      signal VARCHAR NOT NULL,
      entry_time BIGINT NOT NULL,
      entry_price DOUBLE NOT NULL,
      notional DOUBLE NOT NULL,
      quantity DOUBLE NOT NULL,
      entry_fee DOUBLE NOT NULL,
      entry_slippage DOUBLE NOT NULL,
      stop_price DOUBLE NOT NULL,
      target_price DOUBLE NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'OPEN'
    )
  `);
  await connection.run(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS last_checked_price_time BIGINT DEFAULT 0`);
  await connection.run(`UPDATE paper_positions SET last_checked_price_time = entry_time WHERE last_checked_price_time IS NULL OR last_checked_price_time = 0`);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id VARCHAR PRIMARY KEY,
      symbol VARCHAR NOT NULL,
      primary_timeframe VARCHAR NOT NULL,
      direction VARCHAR NOT NULL,
      signal VARCHAR NOT NULL,
      entry_time BIGINT NOT NULL,
      entry_price DOUBLE NOT NULL,
      exit_time BIGINT NOT NULL,
      exit_price DOUBLE NOT NULL,
      notional DOUBLE NOT NULL,
      quantity DOUBLE NOT NULL,
      gross_pnl DOUBLE NOT NULL,
      fees DOUBLE NOT NULL,
      slippage DOUBLE NOT NULL,
      net_pnl DOUBLE NOT NULL,
      exit_reason VARCHAR NOT NULL,
      holding_ms BIGINT NOT NULL
    )
  `);

  const state = await rows(connection, "SELECT value FROM phase7_state WHERE key = 'started_at'");
  if (state.length === 0) {
    const now = Date.now();
    await connection.run(
      "INSERT INTO phase7_state (key, value, updated_at) VALUES ('started_at', ?, ?)",
      [String(now), now],
    );
    await connection.run(
      "INSERT INTO phase7_state (key, value, updated_at) VALUES ('starting_balance', ?, ?)",
      [String(PHASE7_CONFIG.startingBalance), now],
    );
    console.log(`[PAPER] Phase 7 started with virtual balance $${PHASE7_CONFIG.startingBalance.toFixed(2)}.`);
  }
}

export function initializePaperTrading(connection: DatabaseConnection): Promise<void> {
  return withSerializedDatabaseOperation(() => initializePaperTradingUnlocked(connection));
}

async function getStateNumber(connection: DatabaseConnection, key: string): Promise<number> {
  const result = await rows(connection, "SELECT value FROM phase7_state WHERE key = ?", [key]);
  return result.length ? Number(result[0]!.value) : 0;
}

async function latestPrice(connection: DatabaseConnection, symbol: string): Promise<{ price: number; high: number; low: number; closeTime: number; canonicalSymbol: string } | null> {
  const canonicalSymbol = await resolveCanonicalSymbol(symbol);
  const result = await rows(connection, `
    SELECT close, high, low, open_time + 300000 AS close_time
    FROM price_candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY open_time DESC LIMIT 1
  `, [canonicalSymbol, PHASE7_CONFIG.priceTimeframe]);
  if (!result.length) return null;
  const price = asNumber(result[0]!.close);
  const closeTime = asNumber(result[0]!.close_time);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(closeTime)) return null;
  if (Date.now() - closeTime > PHASE7_CONFIG.maxPriceAgeMs || closeTime > Date.now() + 60_000) return null;
  return { price, high: asNumber(result[0]!.high), low: asNumber(result[0]!.low), closeTime, canonicalSymbol };
}

async function portfolio(connection: DatabaseConnection): Promise<{ balance: number; open: DbRow[] }> {
  const startingBalance = await getStateNumber(connection, "starting_balance");
  const closed = await rows(connection, "SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM paper_trades");
  const open = await rows(connection, "SELECT * FROM paper_positions WHERE status = 'OPEN'");
  return { balance: startingBalance + asNumber(closed[0]?.pnl), open };
}

async function closePosition(
  connection: DatabaseConnection,
  position: DbRow,
  marketPrice: number,
  exitReason: string,
): Promise<void> {
  const direction = String(position.direction) as Direction;
  const entryPrice = asNumber(position.entry_price);
  const notional = asNumber(position.notional);
  const quantity = asNumber(position.quantity);
  const entryTime = asNumber(position.entry_time);
  const exitTime = Date.now();
  const adverseExit = marketPrice * (direction === "long"
    ? 1 - PHASE7_CONFIG.slippagePctPerSide / 100
    : 1 + PHASE7_CONFIG.slippagePctPerSide / 100);
  const gross = (adverseExit - entryPrice) * quantity * (direction === "long" ? 1 : -1);
  const exitFee = notional * PHASE7_CONFIG.feePctPerSide / 100;
  const exitSlippage = Math.abs(marketPrice - adverseExit) * quantity;
  const entryFee = asNumber(position.entry_fee);
  const entrySlippage = asNumber(position.entry_slippage);
  const fees = entryFee + exitFee;
  const slippage = entrySlippage + exitSlippage;
  const net = gross - exitFee; // Entry slippage is already reflected in the effective entry price.

  await connection.run("BEGIN TRANSACTION");
  try {
    await connection.run(`
      INSERT INTO paper_trades
      (id, symbol, primary_timeframe, direction, signal, entry_time, entry_price,
       exit_time, exit_price, notional, quantity, gross_pnl, fees, slippage,
       net_pnl, exit_reason, holding_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(position.id), String(position.symbol), String(position.primary_timeframe),
      direction, String(position.signal), entryTime, entryPrice, exitTime, adverseExit,
      notional, quantity, gross, fees, slippage, gross - fees, exitReason, exitTime - entryTime,
    ]);
    await connection.run("UPDATE paper_positions SET status = 'CLOSED' WHERE id = ?", [String(position.id)]);
    await connection.run("COMMIT");
  } catch (error) {
    await connection.run("ROLLBACK");
    throw error;
  }
  console.log(`[PAPER] CLOSE ${position.symbol} ${direction.toUpperCase()} | ${exitReason} | net $${(gross - fees).toFixed(2)}`);
}

async function closeOnStops(connection: DatabaseConnection): Promise<void> {
  const open = await rows(connection, "SELECT * FROM paper_positions WHERE status = 'OPEN'");
  for (const position of open) {
    const canonicalSymbol = await resolveCanonicalSymbol(String(position.symbol));
    const lastChecked = asNumber(position.last_checked_price_time);
    const candles = await rows(connection, `
      SELECT open_time + 300000 AS close_time, high, low, close
      FROM price_candles
      WHERE symbol = ? AND timeframe = ? AND open_time + 300000 > ?
      ORDER BY open_time
    `, [canonicalSymbol, PHASE7_CONFIG.priceTimeframe, lastChecked]);

    const direction = String(position.direction);
    const stop = asNumber(position.stop_price);
    const target = asNumber(position.target_price);
    let closed = false;
    for (const candle of candles) {
      const high = asNumber(candle.high);
      const low = asNumber(candle.low);
      const closeTime = asNumber(candle.close_time);
      // Use closed-candle high/low; if both levels were touched, assume stop first.
      if (direction === "long" && low <= stop) {
        await closePosition(connection, position, stop, "STOP_LOSS");
        closed = true;
        break;
      } else if (direction === "long" && high >= target) {
        await closePosition(connection, position, target, "TAKE_PROFIT");
        closed = true;
        break;
      } else if (direction === "short" && high >= stop) {
        await closePosition(connection, position, stop, "STOP_LOSS");
        closed = true;
        break;
      } else if (direction === "short" && low <= target) {
        await closePosition(connection, position, target, "TAKE_PROFIT");
        closed = true;
        break;
      }
      await connection.run(
        "UPDATE paper_positions SET last_checked_price_time = ? WHERE id = ?",
        [closeTime, String(position.id)],
      );
    }
    if (closed) continue;
  }
}

async function closeOnPrimaryReversals(connection: DatabaseConnection): Promise<void> {
  const open = await rows(connection, "SELECT * FROM paper_positions WHERE status = 'OPEN'");
  for (const position of open) {
    const current = await rows(connection,
      "SELECT signal FROM signals WHERE symbol = ? AND timeframe = ?",
      [String(position.symbol), String(position.primary_timeframe)]);
    const currentDirection = current.length ? signalDirection(String(current[0]!.signal)) : null;
    if (currentDirection === String(position.direction)) continue;
    const quote = await latestPrice(connection, String(position.symbol));
    if (quote) await closePosition(connection, position, quote.price, "PRIMARY_SIGNAL_REVERSAL");
  }
}

async function processPendingEntries(connection: DatabaseConnection): Promise<void> {
  const pending = await rows(connection, "SELECT * FROM paper_pending_entries");
  for (const item of pending) {
    const symbol = String(item.symbol);
    const timeframe = String(item.primary_timeframe);
    const direction = String(item.direction) as Direction;
    const signal = String(item.signal) as SignalType;
    const since = asNumber(item.signal_since);
    if (Date.now() - since < PHASE7_CONFIG.entryConfirmationMs) continue;

    const current = await rows(connection,
      "SELECT signal FROM signals WHERE symbol = ? AND timeframe = ?", [symbol, timeframe]);
    if (!current.length || current[0]!.signal !== signal) {
      await connection.run("DELETE FROM paper_pending_entries WHERE symbol = ? AND primary_timeframe = ?", [symbol, timeframe]);
      continue;
    }

    const quote = await latestPrice(connection, symbol);
    if (!quote) continue;
    // Portfolio accounting is denominated in USD. Until FX conversion and CFD
    // contract multipliers are implemented, trade only USD-quoted instruments.
    if (!quote.canonicalSymbol.toUpperCase().endsWith("USD")) {
      console.warn(`[PAPER] SKIP ${symbol}: ${quote.canonicalSymbol} is not USD-quoted; portfolio conversion is not implemented.`);
      await connection.run("DELETE FROM paper_pending_entries WHERE symbol = ? AND primary_timeframe = ?", [symbol, timeframe]);
      continue;
    }

    const { balance, open } = await portfolio(connection);
    const existingSymbolPosition = open.find((p) => String(p.symbol) === symbol);
    if (existingSymbolPosition) {
      if (String(existingSymbolPosition.direction) === direction) {
        await connection.run("DELETE FROM paper_pending_entries WHERE symbol = ? AND primary_timeframe = ?", [symbol, timeframe]);
      }
      // If the existing position is opposite, retain this pending entry until
      // the reversal exit can be completed with a fresh price.
      continue;
    }
    if (open.length >= PHASE7_CONFIG.maxOpenPositions) continue;

    const currentExposure = open.reduce((sum, p) => sum + asNumber(p.notional), 0);
    const notional = Math.min(balance * PHASE7_CONFIG.positionSizePct / 100,
      balance * PHASE7_CONFIG.maxExposurePct / 100 - currentExposure);
    if (!(notional > 0)) continue;

    const entryPrice = quote.price * (direction === "long"
      ? 1 + PHASE7_CONFIG.slippagePctPerSide / 100
      : 1 - PHASE7_CONFIG.slippagePctPerSide / 100);
    const quantity = notional / entryPrice;
    const entryFee = notional * PHASE7_CONFIG.feePctPerSide / 100;
    const entrySlippage = Math.abs(entryPrice - quote.price) * quantity;
    const stopPrice = entryPrice * (direction === "long"
      ? 1 - PHASE7_CONFIG.stopLossPct / 100
      : 1 + PHASE7_CONFIG.stopLossPct / 100);
    const targetPrice = entryPrice * (direction === "long"
      ? 1 + PHASE7_CONFIG.takeProfitPct / 100
      : 1 - PHASE7_CONFIG.takeProfitPct / 100);

    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run(`
        INSERT INTO paper_positions
        (id, symbol, primary_timeframe, direction, signal, entry_time, entry_price,
         notional, quantity, entry_fee, entry_slippage, stop_price, target_price,
         last_checked_price_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
      `, [crypto.randomUUID(), symbol, timeframe, direction, signal, Date.now(),
        entryPrice, notional, quantity, entryFee, entrySlippage, stopPrice, targetPrice, quote.closeTime]);
      await connection.run("DELETE FROM paper_pending_entries WHERE symbol = ? AND primary_timeframe = ?", [symbol, timeframe]);
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK");
      throw error;
    }
    console.log(`[PAPER] OPEN ${symbol} ${direction.toUpperCase()} via ${timeframe} | entry ${entryPrice} | notional $${notional.toFixed(2)}`);
  }
}

async function processPrimaryChange(connection: DatabaseConnection, change: SignalChange): Promise<void> {
  const timeframe = change.timeframe;
  if (!(PHASE7_CONFIG.primaryTimeframes as readonly string[]).includes(timeframe)) return;

  const newDirection = signalDirection(change.currentSignal);
  const open = await rows(connection,
    "SELECT * FROM paper_positions WHERE symbol = ? AND status = 'OPEN'", [change.symbol]);

  // A primary-timeframe reversal is handled after candle-based stop/target
  // checks. The new direction remains pending until the old position is closed.
  await connection.run("DELETE FROM paper_pending_entries WHERE symbol = ? AND primary_timeframe = ?", [change.symbol, timeframe]);
  if (!newDirection) return;

  // A symbol can have only one live position across all primary timeframes.
  // Same-direction positions are retained; a different timeframe cannot queue
  // a competing trade while another timeframe owns the symbol.
  if (open.some((p) => String(p.primary_timeframe) !== timeframe)) return;
  if (open.some((p) => String(p.direction) === newDirection)) return;
  await connection.run(`
    INSERT INTO paper_pending_entries (symbol, primary_timeframe, direction, signal, signal_since)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (symbol, primary_timeframe) DO UPDATE SET
      direction = EXCLUDED.direction, signal = EXCLUDED.signal,
      signal_since = EXCLUDED.signal_since
  `, [change.symbol, timeframe, newDirection, change.currentSignal, Date.now()]);
}

async function dailyReport(connection: DatabaseConnection): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `daily_report_${day}`;
  const sent = await rows(connection, "SELECT value FROM phase7_state WHERE key = ?", [key]);
  if (sent.length) return;

  const midnight = new Date(`${day}T00:00:00.000Z`).getTime();
  const summary = await rows(connection, `
    SELECT COUNT(*) AS trades,
      COALESCE(SUM(net_pnl), 0) AS net_pnl,
      COALESCE(SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END), 0) AS winners
    FROM paper_trades WHERE exit_time >= ?
  `, [midnight]);
  const now = Date.now();
  await connection.run(
    "INSERT INTO phase7_state (key, value, updated_at) VALUES (?, 'sent', ?)",
    [key, now],
  );
  console.log(`[PAPER] DAILY ${day} | closed ${summary[0]!.trades} | winners ${summary[0]!.winners} | net $${asNumber(summary[0]!.net_pnl).toFixed(2)}`);
}

async function realizedMaxDrawdown(connection: DatabaseConnection): Promise<number> {
  const startingBalance = await getStateNumber(connection, "starting_balance");
  const trades = await rows(connection, "SELECT net_pnl FROM paper_trades ORDER BY exit_time, id");
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += asNumber(trade.net_pnl);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  return maxDrawdown;
}

async function reportIfExpired(connection: DatabaseConnection): Promise<void> {
  const startedAt = await getStateNumber(connection, "started_at");
  if (Date.now() < startedAt + PHASE7_CONFIG.durationMs) return;
  const completed = await rows(connection, "SELECT value FROM phase7_state WHERE key = 'completed_at'");
  if (completed.length) return;

  // Liquidate remaining positions at the latest fresh 5m close so the one-week
  // report has a closed-trade result. Missing/stale prices remain explicitly open.
  const stillOpen = await rows(connection, "SELECT * FROM paper_positions WHERE status = 'OPEN'");
  for (const position of stillOpen) {
    const quote = await latestPrice(connection, String(position.symbol));
    if (quote) await closePosition(connection, position, quote.price, "WEEK_END_LIQUIDATION");
  }

  const summary = await rows(connection, `
    SELECT COUNT(*) AS trades,
      COALESCE(SUM(net_pnl), 0) AS net_pnl,
      COALESCE(SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END), 0) AS winners,
      COALESCE(SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END), 0) AS losers
    FROM paper_trades
  `);
  const open = await rows(connection, "SELECT COUNT(*) AS total FROM paper_positions WHERE status = 'OPEN'");
  const pnlRows = await rows(connection, "SELECT net_pnl FROM paper_trades");
  const grossWins = pnlRows.reduce((sum, row) => sum + Math.max(0, asNumber(row.net_pnl)), 0);
  const grossLosses = pnlRows.reduce((sum, row) => sum + Math.min(0, asNumber(row.net_pnl)), 0);
  const profitFactor = grossLosses < 0 ? grossWins / Math.abs(grossLosses) : grossWins > 0 ? Number.POSITIVE_INFINITY : 0;
  await connection.run("DELETE FROM paper_pending_entries");
  const now = Date.now();
  await connection.run("INSERT INTO phase7_state (key, value, updated_at) VALUES ('completed_at', ?, ?)", [String(now), now]);
  console.log("[PAPER] ===== ONE-WEEK PAPER TRADING PERIOD COMPLETED =====");
  const tradeCount = asNumber(summary[0]!.trades);
  const winnerCount = asNumber(summary[0]!.winners);
  const netPnl = asNumber(summary[0]!.net_pnl);
  const winRate = tradeCount > 0 ? winnerCount / tradeCount * 100 : 0;
  const drawdown = await realizedMaxDrawdown(connection);
  console.log(`[PAPER] Trades: ${tradeCount} | Win rate: ${winRate.toFixed(1)}% | Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"} | Net PnL: $${netPnl.toFixed(2)} | Realized max DD: ${drawdown.toFixed(2)}% | Still open: ${open[0]!.total}`);
  console.log("[PAPER] Trading is now disabled. Review results before any real-money decision.");
}

/** Call after each successful signal poll; idempotency is protected by DB primary keys and pending-entry uniqueness. */
async function runPaperTradingCycleUnlocked(
  connection: DatabaseConnection,
  changes: SignalChange[] = [],
): Promise<void> {
  const startedAt = await getStateNumber(connection, "started_at");
  if (!startedAt) return;
  if (Date.now() >= startedAt + PHASE7_CONFIG.durationMs) {
    await closeOnStops(connection);
    await closeOnPrimaryReversals(connection);
    await reportIfExpired(connection);
    return;
  }

  await dailyReport(connection);
  for (const change of changes) {
    if ((PHASE7_CONFIG.monitorTimeframes as readonly string[]).includes(change.timeframe)) {
      console.log(`[MONITOR] ${change.symbol} ${change.timeframe}: ${change.previousSignal ?? "NEW"} -> ${change.currentSignal} (monitor only)`);
      continue;
    }
    await processPrimaryChange(connection, change);
  }
  await closeOnStops(connection);
  await closeOnPrimaryReversals(connection);
  await processPendingEntries(connection);
}

export function runPaperTradingCycle(
  connection: DatabaseConnection,
  changes: SignalChange[] = [],
): Promise<void> {
  return withSerializedDatabaseOperation(() => runPaperTradingCycleUnlocked(connection, changes));
}

async function logPaperTradingStatusUnlocked(connection: DatabaseConnection): Promise<void> {
  const { balance, open } = await portfolio(connection);
  const closed = await rows(connection, "SELECT COUNT(*) AS count, COALESCE(SUM(net_pnl), 0) AS pnl FROM paper_trades");
  const monitorRows = await rows(connection, `
    SELECT timeframe, COUNT(*) AS symbols FROM signals
    WHERE timeframe IN ('5m', '15m', '30m') GROUP BY timeframe ORDER BY timeframe
  `);
  const monitors = monitorRows.map((r) => `${r.timeframe}:${r.symbols}`).join(" ");
  console.log(`[PAPER] Balance $${balance.toFixed(2)} | open ${open.length} | closed ${closed[0]!.count} | realized PnL $${asNumber(closed[0]!.pnl).toFixed(2)} | monitors ${monitors || "not ready"}`);
}

export function logPaperTradingStatus(connection: DatabaseConnection): Promise<void> {
  return withSerializedDatabaseOperation(() => logPaperTradingStatusUnlocked(connection));
}
