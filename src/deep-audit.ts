/**
 * Phase 7 Deep Audit — READ ONLY
 *
 * Usage:
 *   bun run src/deep-audit.ts
 *   bun run src/deep-audit.ts ./data/signals.duckdb ./deep_audit_vps_result.txt
 *
 * The script only executes SELECT statements against the database. It does not
 * update, delete, migrate, checkpoint, or otherwise mutate trading records.
 */
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  DATABASE_PATH as DEFAULT_DATABASE_PATH,
  PAPER_ENTRY_CONFIRMATION_MS,
  PAPER_MAX_OPEN_POSITIONS,
  PAPER_MAX_PRICE_AGE_MS,
  PAPER_PRICE_TIMEFRAME,
  PAPER_TRADING_DURATION_MS,
  timeframeToMs,
} from "./config";
import { resolveCanonicalSymbol } from "./alignment";

type Row = Record<string, unknown>;

const databasePath = resolve(process.argv[2] ?? DEFAULT_DATABASE_PATH);
const outputPath = resolve(process.argv[3] ?? "./deep_audit_vps_result.txt");
const now = Date.now();

function safeNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function iso(value: unknown): string {
  const timestamp = safeNumber(value);
  if (!timestamp) return "-";
  const normalized = timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function section(title: string, body: string): string {
  return `\n${"=".repeat(88)}\n${title}\n${"=".repeat(88)}\n${body}\n`;
}

function fmt(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

async function main(): Promise<void> {
  // Refuse to create a new empty database if the supplied path is wrong.
  await access(databasePath);
  const instance = await DuckDBInstance.create(databasePath, {
    access_mode: "READ_ONLY",
  });
  const connection = await instance.connect();
  const output: string[] = [];

  async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await connection.runAndReadAll(sql, params as any[]);
    return result.getRowObjects() as unknown as Row[];
  }

  async function tableExists(table: string): Promise<boolean> {
    const result = await query(
      `SELECT COUNT(*) AS total
       FROM information_schema.tables
       WHERE table_schema = 'main' AND table_name = ?`,
      [table],
    );
    return safeNumber(result[0]?.total) > 0;
  }

  async function tableColumns(table: string): Promise<string[]> {
    const result = await query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'main' AND table_name = ?
       ORDER BY ordinal_position`,
      [table],
    );
    return result.map((row) => String(row.column_name));
  }

  async function tableRows(table: string, orderBy = ""): Promise<Row[]> {
    if (!(await tableExists(table))) return [];
    const safeOrder = orderBy ? ` ORDER BY ${orderBy}` : "";
    return query(`SELECT * FROM "${table}"${safeOrder}`);
  }

  async function canonical(symbol: string): Promise<string> {
    try {
      return await resolveCanonicalSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  output.push("DAILY SIGNALS — PHASE 7 DEEP AUDIT");
  output.push(`Generated UTC: ${new Date(now).toISOString()}`);
  output.push(`Database: ${databasePath}`);
  output.push("Mode: READ ONLY — no trading tables are modified.");
  output.push("");

  // 1. Database inventory and schema.
  const tables = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const inventory: Row[] = [];
  for (const item of tables) {
    const table = String(item.table_name);
    const count = await query(`SELECT COUNT(*) AS total FROM "${table}"`);
    inventory.push({
      table,
      rows: safeNumber(count[0]?.total),
      columns: await tableColumns(table),
    });
  }
  output.push(section("1. DATABASE INVENTORY AND SCHEMA", json(inventory)));

  // 2. Phase 7 state and experiment clock.
  const stateRows = await tableRows("phase7_state", "key");
  const state = new Map(stateRows.map((row) => [String(row.key), String(row.value)]));
  const startedAt = safeNumber(state.get("started_at"));
  const completedAt = safeNumber(state.get("completed_at"));
  const durationMs = PAPER_TRADING_DURATION_MS;
  const candleMs = timeframeToMs(PAPER_PRICE_TIMEFRAME);
  const stateSummary = {
    rows: stateRows,
    started_at_utc: startedAt ? iso(startedAt) : null,
    completed_at_utc: completedAt ? iso(completedAt) : null,
    elapsed_wall_clock_hours: startedAt
      ? fmt(((completedAt || now) - startedAt) / 3_600_000, 2)
      : null,
    nominal_duration_hours: fmt(durationMs / 3_600_000, 2),
    nominal_remaining_hours: startedAt && !completedAt
      ? fmt(Math.max(0, startedAt + durationMs - now) / 3_600_000, 2)
      : null,
    note: "Wall-clock elapsed time is not proof of valid engine uptime. Compare with code-fix deployment and service restart timestamps.",
  };
  output.push(section("2. PHASE 7 STATE AND EXPERIMENT CLOCK", json(stateSummary)));

  // 3. Signal and polling coverage.
  const signalCoverage = await tableExists("signals")
    ? await query(`
        SELECT timeframe, COUNT(*) AS symbols,
               COUNT(DISTINCT signal) AS signal_types,
               MAX(updated_at) AS latest_update
        FROM signals
        GROUP BY timeframe
        ORDER BY timeframe
      `)
    : [];
  const pollState = await tableRows("poll_state", "timeframe");
  output.push(section("3. SIGNAL COVERAGE", json(signalCoverage)));
  output.push(section("4. POLL STATE", json(pollState.map((row) => ({
    ...row,
    initialized_at_utc: iso(row.initialized_at),
    last_polled_at_utc: iso(row.last_polled_at),
    poll_age_minutes: fmt((now - safeNumber(row.last_polled_at)) / 60_000, 2),
  })))));

  // 4. Pending entries with per-row diagnosis.
  const pendingRows = await tableRows("paper_pending_entries", "signal_since, symbol");
  const openRows = await tableRows("paper_positions", "entry_time");
  const pendingDiagnostics: Row[] = [];
  const openCount = openRows.filter((row) => String(row.status).toUpperCase() === "OPEN").length;

  for (const pending of pendingRows) {
    const symbol = String(pending.symbol);
    const timeframe = String(pending.primary_timeframe);
    const expectedSignal = String(pending.signal);
    const since = safeNumber(pending.signal_since);
    const ageMs = Math.max(0, now - since);
    const current = await query(
      "SELECT signal, updated_at FROM signals WHERE symbol = ? AND timeframe = ?",
      [symbol, timeframe],
    );
    const canonicalSymbol = await canonical(symbol);
    const quoteRows = await tableExists("price_candles")
      ? await query(`
          SELECT open_time, close, collected_at,
                 open_time + ${candleMs} AS close_time
          FROM price_candles
          WHERE symbol = ? AND timeframe = ?
          ORDER BY open_time DESC LIMIT 1
        `, [canonicalSymbol, PAPER_PRICE_TIMEFRAME])
      : [];
    const quote = quoteRows[0];
    const quoteAgeMs = quote ? now - safeNumber(quote.close_time) : null;
    const signalMatches = current.length > 0 &&
      String(current[0]!.signal) === expectedSignal;

    let diagnosis = "READY_OR_REQUIRES_PORTFOLIO_CHECK";
    if (!signalMatches) diagnosis = "SIGNAL_MISSING_OR_CHANGED";
    else if (ageMs < PAPER_ENTRY_CONFIRMATION_MS) diagnosis = "CONFIRMATION_NOT_ELAPSED";
    else if (!quote) diagnosis = "NO_5M_PRICE_CANDLE";
    else if (quoteAgeMs! < 0 || quoteAgeMs! > PAPER_MAX_PRICE_AGE_MS) diagnosis = "PRICE_STALE_OR_FUTURE";
    else if (!canonicalSymbol.toUpperCase().endsWith("USD")) diagnosis = "NON_USD_QUOTE_UNSUPPORTED";
    else if (openCount >= PAPER_MAX_OPEN_POSITIONS) diagnosis = "GLOBAL_OPEN_POSITION_CAP";

    pendingDiagnostics.push({
      ...pending,
      canonical_symbol: canonicalSymbol,
      age_minutes: fmt(ageMs / 60_000, 2),
      confirmation_remaining_minutes: fmt(Math.max(0, PAPER_ENTRY_CONFIRMATION_MS - ageMs) / 60_000, 2),
      current_signal: current[0]?.signal ?? null,
      current_signal_updated_at_utc: current[0] ? iso(current[0].updated_at) : null,
      signal_matches: signalMatches,
      latest_5m_close: quote?.close ?? null,
      latest_5m_close_time_utc: quote ? iso(quote.close_time) : null,
      latest_5m_collected_at_utc: quote ? iso(quote.collected_at) : null,
      latest_5m_price_age_minutes: quoteAgeMs === null ? null : fmt(quoteAgeMs / 60_000, 2),
      diagnosis,
    });
  }
  output.push(section(
    `5. ALL PENDING ENTRIES (${pendingDiagnostics.length})`,
    json(pendingDiagnostics),
  ));

  // 5. Open positions and mark-to-market diagnostics.
  const openDiagnostics: Row[] = [];
  for (const position of openRows.filter((row) => String(row.status).toUpperCase() === "OPEN")) {
    const symbol = String(position.symbol);
    const canonicalSymbol = await canonical(symbol);
    const quoteRows = await query(`
      SELECT open_time, close, collected_at,
             open_time + ${candleMs} AS close_time
      FROM price_candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY open_time DESC LIMIT 1
    `, [canonicalSymbol, PAPER_PRICE_TIMEFRAME]);
    const quote = quoteRows[0];
    const entry = safeNumber(position.entry_price);
    const quantity = safeNumber(position.quantity);
    const direction = String(position.direction);
    const mark = quote ? safeNumber(quote.close) : null;
    const unrealized = mark === null
      ? null
      : (mark - entry) * quantity * (direction === "long" ? 1 : -1);
    const lastChecked = safeNumber(position.last_checked_price_time);
    openDiagnostics.push({
      ...position,
      canonical_symbol: canonicalSymbol,
      last_checked_price_time_utc: iso(lastChecked),
      last_checked_age_minutes: fmt((now - lastChecked) / 60_000, 2),
      latest_5m_close: mark,
      latest_5m_close_time_utc: quote ? iso(quote.close_time) : null,
      latest_5m_collected_at_utc: quote ? iso(quote.collected_at) : null,
      latest_5m_price_age_minutes: quote
        ? fmt((now - safeNumber(quote.close_time)) / 60_000, 2)
        : null,
      unrealized_pnl_before_exit_costs: unrealized,
    });
  }
  output.push(section(
    `6. OPEN POSITIONS (${openDiagnostics.length})`,
    json(openDiagnostics),
  ));

  // 6. Closed trade ledger and performance recalculation.
  const trades = await tableRows("paper_trades", "exit_time, id");
  const pnlValues = trades.map((row) => safeNumber(row.net_pnl));
  const winners = pnlValues.filter((value) => value > 0);
  const losers = pnlValues.filter((value) => value < 0);
  const grossProfit = winners.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  let equity = safeNumber(state.get("starting_balance"));
  let peak = equity;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity += safeNumber(trade.net_pnl);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  let currentLosingStreak = 0;
  let maxLosingStreak = 0;
  for (const trade of trades) {
    if (safeNumber(trade.net_pnl) < 0) {
      currentLosingStreak++;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
    } else {
      currentLosingStreak = 0;
    }
  }
  const tradeSummary = {
    closed_trades: trades.length,
    wins: winners.length,
    losses: losers.length,
    breakeven: trades.length - winners.length - losers.length,
    win_rate_pct: trades.length ? winners.length / trades.length * 100 : 0,
    realized_net_pnl: pnlValues.reduce((sum, value) => sum + value, 0),
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? "Infinity" : 0,
    average_win: winners.length ? grossProfit / winners.length : 0,
    average_loss: losers.length ? -grossLoss / losers.length : 0,
    max_realized_drawdown_pct: maxDrawdownPct,
    max_consecutive_losses: maxLosingStreak,
    realized_balance: safeNumber(state.get("starting_balance")) + pnlValues.reduce((sum, value) => sum + value, 0),
    exit_reasons: await query(`
      SELECT exit_reason, COUNT(*) AS trades, SUM(net_pnl) AS net_pnl
      FROM paper_trades
      GROUP BY exit_reason
      ORDER BY trades DESC
    `),
  };
  output.push(section("7. RECALCULATED CLOSED-TRADE PERFORMANCE", json(tradeSummary)));
  output.push(section(`8. COMPLETE CLOSED-TRADE LEDGER (${trades.length})`, json(trades)));

  // 7. All positions and consistency checks.
  const allPositions = await tableRows("paper_positions", "entry_time, id");
  const openIds = new Set(
    allPositions
      .filter((row) => String(row.status).toUpperCase() === "OPEN")
      .map((row) => String(row.id)),
  );
  const tradeIds = new Set(trades.map((row) => String(row.id)));
  const closedWithoutTrade = allPositions
    .filter((row) => String(row.status).toUpperCase() === "CLOSED" && !tradeIds.has(String(row.id)))
    .map((row) => row.id);
  const openWithTrade = [...openIds].filter((id) => tradeIds.has(id));
  const consistency = {
    positions_total: allPositions.length,
    positions_open: openIds.size,
    positions_closed: allPositions.length - openIds.size,
    trades_total: trades.length,
    closed_positions_without_trade: closedWithoutTrade,
    open_positions_with_trade: openWithTrade,
    trade_ids_without_position: trades
      .filter((trade) => !allPositions.some((position) => String(position.id) === String(trade.id)))
      .map((trade) => trade.id),
    duplicate_trade_ids: trades
      .map((trade) => String(trade.id))
      .filter((id, index, all) => all.indexOf(id) !== index),
  };
  output.push(section("9. POSITION / TRADE CONSISTENCY", json(consistency)));
  output.push(section(`10. COMPLETE POSITION LEDGER (${allPositions.length})`, json(allPositions)));

  // 8. 5m price freshness for every canonical symbol.
  const priceColumns = await tableColumns("price_candles");
  const hasCollectedAt = priceColumns.includes("collected_at");
  const priceFreshness = await tableExists("price_candles")
    ? await query(`
        SELECT symbol, COUNT(*) AS candles,
               MAX(open_time) AS latest_open_time,
               MAX(open_time + ${candleMs}) AS latest_close_time
               ${hasCollectedAt ? ", MAX(collected_at) AS latest_collected_at" : ""}
        FROM price_candles
        WHERE timeframe = ?
        GROUP BY symbol
        ORDER BY symbol
      `, [PAPER_PRICE_TIMEFRAME])
    : [];
  const freshnessSummary = {
    canonical_symbols_with_5m_data: priceFreshness.length,
    collected_at_available: hasCollectedAt,
    symbols: priceFreshness.map((row) => ({
      ...row,
      latest_open_time_utc: iso(row.latest_open_time),
      latest_close_time_utc: iso(row.latest_close_time),
      latest_collected_at_utc: hasCollectedAt ? iso(row.latest_collected_at) : null,
      candle_close_age_minutes: fmt((now - safeNumber(row.latest_close_time)) / 60_000, 2),
      collection_age_minutes: hasCollectedAt
        ? fmt((now - safeNumber(row.latest_collected_at)) / 60_000, 2)
        : null,
    })),
  };
  output.push(section("11. 5M PRICE-CANDLE FRESHNESS BY SYMBOL", json(freshnessSummary)));

  // 9. Latest stored reports versus the recomputed ledger.
  const reports = await tableRows("phase7_reports", "created_at DESC");
  output.push(section("12. STORED PHASE 7 REPORTS (NEWEST FIRST)", json(reports)));
  const latestReport = reports[0];
  output.push(section("13. LATEST REPORT RECONCILIATION", json({
    latest_report: latestReport ?? null,
    ledger_closed_trades: trades.length,
    ledger_net_pnl: tradeSummary.realized_net_pnl,
    ledger_realized_balance: tradeSummary.realized_balance,
    report_trade_count_matches: latestReport
      ? safeNumber(latestReport.closed_trades) === trades.length
      : null,
    report_pnl_matches: latestReport
      ? Math.abs(safeNumber(latestReport.net_pnl) - safeNumber(tradeSummary.realized_net_pnl)) < 0.000001
      : null,
    note: "The report's balance is realized balance only; open-position unrealized PnL is shown separately above.",
  })));

  // 10. Full Phase 7 operational tables.
  for (const table of ["phase7_state", "paper_pending_entries", "paper_positions", "paper_trades", "phase7_reports"]) {
    if (await tableExists(table)) {
      const rows = await tableRows(table);
      output.push(section(`14. RAW TABLE DUMP: ${table} (${rows.length})`, json(rows)));
    }
  }

  output.push(section("AUDIT LIMITATIONS", [
    "- This report is a point-in-time read-only snapshot.",
    "- It cannot infer when a code fix was deployed; compare service restart/deployment logs.",
    "- A stale or absent quote is not treated as zero unrealized PnL.",
    "- Mark-to-market PnL excludes hypothetical exit slippage and exit fees.",
    "- The 5m pending/position diagnostics use the Phase 7 configured freshness assumptions (5m candles, 15-minute maximum age).",
    "- No strategy parameters or database records were changed.",
  ].join("\n")));

  const report = output.join("\n");
  await writeFile(outputPath, report, "utf8");
  console.log(`[AUDIT] Read-only audit complete.`);
  console.log(`[AUDIT] Database: ${databasePath}`);
  console.log(`[AUDIT] Output: ${outputPath}`);
  console.log(`[AUDIT] Trades: ${trades.length} | Open positions: ${openDiagnostics.length} | Pending: ${pendingDiagnostics.length}`);
  connection.disconnectSync();
}

await main().catch((error) => {
  console.error("[AUDIT ERROR]", error);
  process.exitCode = 1;
});
