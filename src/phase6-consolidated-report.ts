/**
 * Phase 6 Consolidated Readiness Report — read-only.
 *
 * One consolidated report over the current (extended) VPS research dataset:
 *   1. Dataset identity (fingerprint, row counts, min/max timestamps)
 *   2. Historical coverage (per timeframe: candles, first/last, calendar days)
 *   3. Event sample + strict entry eligibility (per timeframe)
 *   4. Symbol diversity (eligible events per symbol, concentration)
 *   5. Candle quality (future candles, stale references, interval gaps, integrity)
 *   6. Independence (snapshots vs transitions vs eligible events)
 *   7. Frozen Phase 6 acceptance / readiness criteria evaluation (PASS / FAIL)
 *   8. Reproducibility (frozen lock fingerprint vs current fingerprint)
 *   9. Comparison with the previous (pre-extension) dataset
 *
 * Read-only: no writes, no persistence, no strategy / database changes.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { alignTimeframe, type AlignedSignal } from "./alignment";
import { computeTransitions, type SignalTransition } from "./evaluation";
import type { DatabaseConnection } from "./database";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/signals.duckdb";

const LOCKED_DATASET_FINGERPRINT =
  "fcc8504ac77b208549295dd63ff254984696f8ea293036cce30fda36ee7cbc55";
const LOCKED_AT = "2026-11-04T04:01:35Z";

const EVALUATED_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h"];

interface CriterionResult {
  key: string;
  label: string;
  status: "PASS" | "FAIL";
  value: string;
}

let db: DatabaseConnection;

function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const inner = obj.value;
    if (typeof inner === "bigint" || typeof inner === "number") {
      return Number(inner);
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
  }
  return String(value);
}

function toMs(value: unknown): number {
  return toNum(value);
}

function fmtTs(ms: unknown): string {
  const t = toMs(ms);
  if (t <= 0) return "-";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function fmtDays(ms: unknown): string {
  const days = toMs(ms) / 86_400_000;
  return `${days.toFixed(2)} days`;
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

type Row = Record<string, unknown>;

async function q(sql: string): Promise<Row[]> {
  const result = (await db.run(sql)) as unknown as {
    getRowObjects(): Promise<Record<string, unknown>[]>;
  };
  return (await result.getRowObjects()) as Row[];
}

function printTable(title: string, rows: Row[], columns: string[]): void {
  console.log(`\n========== ${title} ==========`);
  console.log(columns.map((c) => c).join(" | "));
  for (const row of rows) {
    console.log(
      columns.map((c) => String(row[c] ?? "-")).join(" | "),
    );
  }
}

const EVENT_CTE = `
  WITH timeframes(timeframe, seconds) AS (
    VALUES
      ('5m', 300.0),
      ('15m', 900.0),
      ('30m', 1800.0),
      ('1h', 3600.0),
      ('4h', 14400.0),
      ('5h', 18000.0),
      ('1d', 86400.0),
      ('1w', 604800.0)
  ),
  signal_symbols AS (
    SELECT DISTINCT symbol AS signal_symbol FROM signal_history
  ),
  candle_symbols AS (
    SELECT DISTINCT symbol AS candle_symbol FROM price_candles
  ),
  candidates AS (
    SELECT
      s.signal_symbol,
      c.candle_symbol
    FROM signal_symbols s
    JOIN candle_symbols c
      ON regexp_replace(upper(s.signal_symbol), '[^A-Z0-9]', '', 'g')
         = regexp_replace(upper(c.candle_symbol), '[^A-Z0-9]', '', 'g')
  ),
  unique_mapping AS (
    SELECT signal_symbol, MIN(candle_symbol) AS candle_symbol
    FROM candidates
    GROUP BY signal_symbol
    HAVING COUNT(*) = 1
  ),
  event_matches AS (
    SELECT
      h.event_id,
      h.symbol AS signal_symbol,
      m.candle_symbol,
      h.timeframe,
      h.current_signal,
      h.timestamp,
      previous_candle.open_time AS previous_candle_time,
      next_candle.open_time AS next_candle_time
    FROM signal_history h
    LEFT JOIN unique_mapping m ON m.signal_symbol = h.symbol
    LEFT JOIN LATERAL (
      SELECT c.open_time FROM price_candles c
      WHERE c.symbol = m.candle_symbol AND c.timeframe = h.timeframe AND c.open_time <= h.timestamp
      ORDER BY c.open_time DESC LIMIT 1
    ) previous_candle ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.open_time FROM price_candles c
      WHERE c.symbol = m.candle_symbol AND c.timeframe = h.timeframe AND c.open_time > h.timestamp
      ORDER BY c.open_time ASC LIMIT 1
    ) next_candle ON TRUE
  ),
  timed AS (
    SELECT
      e.*,
      tf.seconds AS timeframe_seconds,
      (e.timestamp - e.previous_candle_time) / 1000.0 AS prev_candle_age_s,
      (e.next_candle_time - e.timestamp) / 1000.0 AS next_candle_wait_s
    FROM event_matches e
    JOIN timeframes tf ON tf.timeframe = e.timeframe
  )
`;

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(DATABASE_PATH);
  db = await instance.connect();

  try {
    // ============ 1. DATASET IDENTITY ============
    const identityRows = await q(`
      SELECT
        (SELECT COUNT(*) FROM signal_history) AS signal_history_rows,
        (SELECT MIN(timestamp) FROM signal_history) AS signal_history_min_ts,
        (SELECT MAX(timestamp) FROM signal_history) AS signal_history_max_ts,
        (SELECT COUNT(*) FROM signal_snapshots) AS signal_snapshots_rows,
        (SELECT MIN(observed_at) FROM signal_snapshots) AS snapshots_min_observed,
        (SELECT MAX(observed_at) FROM signal_snapshots) AS snapshots_max_observed,
        (SELECT COUNT(*) FROM price_candles) AS price_candles_rows,
        (SELECT MIN(open_time) FROM price_candles) AS candles_min_open,
        (SELECT MAX(open_time) FROM price_candles) AS candles_max_open
    `);
    const identity = identityRows[0] ?? ({} as Row);

    console.log("========== 1. DATASET IDENTITY ==========");
    console.log(`signal_history_rows        = ${toNum(identity.signal_history_rows)}`);
    console.log(`signal_history_min_ts       = ${fmtTs(identity.signal_history_min_ts)}`);
    console.log(`signal_history_max_ts       = ${fmtTs(identity.signal_history_max_ts)}`);
    console.log(`signal_snapshots_rows      = ${toNum(identity.signal_snapshots_rows)}`);
    console.log(`snapshots_min_observed     = ${fmtTs(identity.snapshots_min_observed)}`);
    console.log(`snapshots_max_observed     = ${fmtTs(identity.snapshots_max_observed)}`);
    console.log(`price_candles_rows          = ${toNum(identity.price_candles_rows)}`);
    console.log(`candles_min_open            = ${fmtTs(identity.candles_min_open)}`);
    console.log(`candles_max_open            = ${fmtTs(identity.candles_max_open)}`);

    // ============ 2. HISTORICAL COVERAGE (PER TIMEFRAME) ============
    const coverage = await q(`
      SELECT
        timeframe,
        COUNT(*) AS candles,
        MIN(open_time) AS first_open_time,
        MAX(open_time) AS last_open_time,
        ROUND((MAX(open_time) - MIN(open_time)) / 86400000.0, 2) AS calendar_days_span,
        COUNT(DISTINCT symbol) AS symbols
      FROM price_candles
      GROUP BY timeframe
      ORDER BY timeframe
    `);
    const coverageByTf = new Map<string, Row>();
    for (const row of coverage) {
      coverageByTf.set(toStr(row.timeframe), row);
    }
    console.log("\n========== 2. HISTORICAL COVERAGE (PER TIMEFRAME) ==========");
    for (const tf of ["5m", "15m", "30m", "1h", "4h", "1d", "5h", "1w"]) {
      const row = coverageByTf.get(tf);
      if (!row) {
        console.log(`${tf}: no candles`);
        continue;
      }
      console.log(
        `${tf}: candles=${toNum(row.candles)} symbols=${toNum(row.symbols)} first=${fmtTs(row.first_open_time)} last=${fmtTs(row.last_open_time)} span=${fmtDays(toMs(row.last_open_time) - toMs(row.first_open_time))}`,
      );
    }

    // ============ 3. EVENT SAMPLE + STRICT ENTRY ELIGIBILITY ============
    const events = await q(`${EVENT_CTE}
      SELECT
        timeframe,
        timeframe_seconds,
        COUNT(*) AS total_events,
        COUNT(candle_symbol) AS mapped_events,
        COUNT(*) FILTER (
          WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NOT NULL
        ) AS eligible_events,
        COUNT(*) FILTER (WHERE candle_symbol IS NULL) AS excluded_unmatched,
        COUNT(*) FILTER (WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NULL) AS excluded_no_previous_candle,
        COUNT(*) FILTER (WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NULL) AS excluded_no_next_candle,
        MIN(timestamp) FILTER (
          WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NOT NULL
        ) AS first_eligible_ts,
        MAX(timestamp) FILTER (
          WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NOT NULL
        ) AS last_eligible_ts
      FROM timed
      GROUP BY timeframe, timeframe_seconds
      ORDER BY timeframe
    `);
    const eventsByTf = new Map<string, Row>();
    for (const row of events) {
      eventsByTf.set(toStr(row.timeframe), row);
    }
    console.log("\n========== 3. EVENT SAMPLE AND STRICT ENTRY ELIGIBILITY ==========");
    for (const tf of ["5m", "15m", "30m", "1h", "4h", "5h", "1d", "1w"]) {
      const row = eventsByTf.get(tf);
      if (!row) {
        console.log(`${tf}: no events`);
        continue;
      }
      console.log(
        `${tf}: timeframe_seconds=${toNum(row.timeframe_seconds)} total=${toNum(row.total_events)} mapped=${toNum(row.mapped_events)} eligible=${toNum(row.eligible_events)} excluded_unmatched=${toNum(row.excluded_unmatched)} excluded_no_prev=${toNum(row.excluded_no_previous_candle)} excluded_no_next=${toNum(row.excluded_no_next_candle)} first=${fmtTs(row.first_eligible_ts)} last=${fmtTs(row.last_eligible_ts)}`,
      );
    }

    // ============ 3b. ELIGIBLE EVENTS BY DIRECTION ============
    const directions = await q(`${EVENT_CTE}
      SELECT
        timeframe,
        current_signal,
        COUNT(*) AS eligible_events
      FROM timed
      WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NOT NULL
      GROUP BY timeframe, current_signal
      ORDER BY timeframe, current_signal
    `);
    const directionsByTf = new Map<string, Row[]>();
    for (const row of directions) {
      const tf = toStr(row.timeframe);
      const list = directionsByTf.get(tf) ?? [];
      list.push(row);
      directionsByTf.set(tf, list);
    }
    console.log("\n========== 3b. ELIGIBLE EVENTS BY DIRECTION ==========");
    for (const tf of ["5m", "15m", "30m", "1h", "4h", "5h", "1d", "1w"]) {
      const list = directionsByTf.get(tf) ?? [];
      const parts = list.map((r) => `${toStr(r.current_signal)}=${toNum(r.eligible_events)}`);
      console.log(`${tf}: ${parts.join(", ")}`);
    }

    // ============ 4. SYMBOL DIVERSITY (ELIGIBLE EVENTS) ============
    const symbolRows = await q(`${EVENT_CTE}
      SELECT
        timeframe,
        signal_symbol,
        COUNT(*) AS eligible_events
      FROM timed
      WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL AND next_candle_time IS NOT NULL
      GROUP BY timeframe, signal_symbol
      ORDER BY timeframe, eligible_events DESC
    `);
    const symbolsByTf = new Map<string, Row[]>();
    for (const row of symbolRows) {
      const tf = toStr(row.timeframe);
      const list = symbolsByTf.get(tf) ?? [];
      list.push(row);
      symbolsByTf.set(tf, list);
    }
    console.log("\n========== 4. SYMBOL DIVERSITY (ELIGIBLE EVENTS PER SYMBOL) ==========");
    for (const tf of ["5m", "15m", "30m", "1h", "4h", "5h", "1d", "1w"]) {
      const list = symbolsByTf.get(tf) ?? [];
      const total = list.reduce((acc, r) => acc + toNum(r.eligible_events), 0);
      const sorted = [...list].sort((a, b) => toNum(b.eligible_events) - toNum(a.eligible_events));
      const top1 = sorted[0];
      const top10 = sorted.slice(0, 10);
      const top1Events = top1 ? toNum(top1.eligible_events) : 0;
      const top10Events = top10.reduce((acc, r) => acc + toNum(r.eligible_events), 0);
      console.log(
        `${tf}: eligible_total=${total} distinct_symbols=${list.length} top1=${top1 ? toStr(top1.signal_symbol) : "-"}(${top1Events} events, ${total > 0 ? ((top1Events / total) * 100).toFixed(1) : "0"}%) top10_share=${total > 0 ? ((top10Events / total) * 100).toFixed(1) : "0"}%`,
      );
    }

    // ============ 5. CANDLE QUALITY ============
    const futureRows = await q(`
      SELECT timeframe, COUNT(*) AS future_candles
      FROM price_candles
      WHERE open_time > EXTRACT(EPOCH FROM now()) * 1000
      GROUP BY timeframe
      ORDER BY timeframe
    `);
    console.log("\n========== 5. CANDLE QUALITY ==========");
    console.log("future candles (open_time > now):");
    for (const row of futureRows) {
      console.log(`  ${toStr(row.timeframe)}: ${toNum(row.future_candles)}`);
    }

    const staleRows = await q(`${EVENT_CTE}
      SELECT
        timeframe,
        timeframe_seconds,
        COUNT(*) AS valid_price_ref_events,
        COUNT(*) FILTER (WHERE prev_candle_age_s > timeframe_seconds) AS stale_events
      FROM timed
      WHERE candle_symbol IS NOT NULL AND previous_candle_time IS NOT NULL
      GROUP BY timeframe, timeframe_seconds
      ORDER BY timeframe
    `);
    console.log("stale price references (prev candle age > interval):");
    for (const row of staleRows) {
      const intervalSec = toNum(row.timeframe_seconds);
      const valid = toNum(row.valid_price_ref_events);
      const stale = toNum(row.stale_events);
      console.log(
        `  ${toStr(row.timeframe)}: valid=${valid} stale=${stale} stale_rate=${valid > 0 ? ((stale / valid) * 100).toFixed(2) : "0"}%`,
      );
    }

    const gapRows = await q(`
      WITH timeframes(timeframe, seconds) AS (
        VALUES
          ('5m', 300.0),
          ('15m', 900.0),
          ('30m', 1800.0),
          ('1h', 3600.0),
          ('4h', 14400.0),
          ('5h', 18000.0),
          ('1d', 86400.0),
          ('1w', 604800.0)
      ),
      g AS (
        SELECT
          timeframe,
          symbol,
          open_time - LAG(open_time) OVER (
            PARTITION BY symbol, timeframe ORDER BY open_time
          ) AS gap_ms
        FROM price_candles
      )
      SELECT
        g.timeframe,
        COUNT(*) FILTER (WHERE g.gap_ms IS NOT NULL AND g.gap_ms > t.seconds * 1000) AS gap_violations,
        MAX(g.gap_ms) FILTER (WHERE g.gap_ms IS NOT NULL) AS max_gap_ms
      FROM g
      JOIN timeframes t ON t.timeframe = g.timeframe
      GROUP BY g.timeframe
      ORDER BY g.timeframe
    `);
    console.log("candle interval gaps (gap_ms > interval):");
    for (const row of gapRows) {
      console.log(
        `  ${toStr(row.timeframe)}: gap_violations=${toNum(row.gap_violations)} max_gap_ms=${toNum(row.max_gap_ms)}`,
      );
    }

    const dupRows = await q(`
      SELECT symbol, timeframe, open_time, COUNT(*) AS cnt
      FROM price_candles
      GROUP BY symbol, timeframe, open_time
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 10
    `);
    const dupCount = dupRows.length;
    console.log(`candle duplicate keys (symbol,timeframe,open_time) with >1 row: ${dupCount}`);

    const ohlcRows = await q(`
      SELECT COUNT(*) AS invalid_ohlc
      FROM price_candles
      WHERE low > high OR open > high OR open < low OR close > high OR close < low
    `);
    const ohlcRow = ohlcRows[0] ?? ({} as Row);
    console.log(`invalid OHLC candles: ${toNum(ohlcRow.invalid_ohlc)}`);

    // ============ 6. INDEPENDENCE (5m AND 15m) ============
    console.log("\n========== 6. INDEPENDENCE ==========");
    for (const tf of ["5m", "15m"]) {
      const aligned: AlignedSignal[] = await alignTimeframe(db, tf);
      const transitions: SignalTransition[] = computeTransitions(tf, aligned);
      const fresh = transitions.filter((t) => t.fresh).length;
      const directional = transitions.filter(
        (t) =>
          t.currentSignal === "BUY" ||
          t.currentSignal === "STRONG_BUY" ||
          t.currentSignal === "SELL" ||
          t.currentSignal === "STRONG_SELL",
      ).length;
      const snaps = await q(`SELECT timeframe, COUNT(*) AS snapshots FROM signal_snapshots GROUP BY timeframe ORDER BY timeframe`);
      const snapRow = snaps.find((r) => toStr(r.timeframe) === tf);
      console.log(
        `${tf}: snapshots=${snapRow ? toNum(snapRow.snapshots) : 0} transitions=${transitions.length} fresh=${fresh} directional=${directional}`,
      );
    }

    // ============ 7. FROZEN PHASE 6 CRITERIA EVALUATION ============
    const criteria: CriterionResult[] = [];
    for (const tf of EVALUATED_TIMEFRAMES) {
      const cov = coverageByTf.get(tf);
      const ev = eventsByTf.get(tf);
      const days = cov ? (toMs(cov.last_open_time) - toMs(cov.first_open_time)) / 86_400_000 : 0;
      const eligible = ev ? toNum(ev.eligible_events) : 0;
      const total = ev ? toNum(ev.total_events) : 0;
      const joinCoveragePct = total > 0 ? (eligible / total) * 100 : 0;

      criteria.push({
        key: "observation_period",
        label: "Observation period ≥ 30 calendar days (per evaluated timeframe)",
        status: days >= 30 ? "PASS" : "FAIL",
        value: `${tf}: ${days.toFixed(2)} days (candles=${cov ? toNum(cov.candles) : 0})`,
      });

      const dirList = directionsByTf.get(tf) ?? [];
      const dirCounts = new Map<string, number>();
      for (const d of dirList) {
        dirCounts.set(toStr(d.current_signal), toNum(d.eligible_events));
      }
      const minDir = Math.min(
        ...[...dirCounts.entries()].map(([, v]) => v),
      );
      criteria.push({
        key: "event_sample",
        label: "Event sample ≥ 30 usable events per timeframe; ≥ 15 per direction",
        status: eligible >= 30 && minDir >= 15 ? "PASS" : "FAIL",
        value: `${tf}: eligible=${eligible} min_direction=${minDir} dirs=${JSON.stringify(Object.fromEntries(dirCounts))}`,
      });

      criteria.push({
        key: "join_coverage",
        label: "Join coverage ≥ 95% valid joins; ≤ 5% invalid",
        status: joinCoveragePct >= 95 ? "PASS" : "FAIL",
        value: `${tf}: eligible_joins=${eligible}/${total} (${joinCoveragePct.toFixed(2)}%)`,
      });
    }
    // Symbol concentration criterion (per evaluated timeframe, eligible events).
    for (const tf of EVALUATED_TIMEFRAMES) {
      const list = symbolsByTf.get(tf) ?? [];
      const total = list.reduce((acc, r) => acc + toNum(r.eligible_events), 0);
      const sorted = [...list].sort((a, b) => toNum(b.eligible_events) - toNum(a.eligible_events));
      const top1 = sorted[0];
      const top10 = sorted.slice(0, 10);
      const top1Events = top1 ? toNum(top1.eligible_events) : 0;
      const top10Events = top10.reduce((acc, r) => acc + toNum(r.eligible_events), 0);
      const maxSingleOk = top1 ? top1Events / total <= 0.1 : false;
      const top10Ok = top10Events / total <= 0.25;
      const distinctOk = list.length >= 30;
      criteria.push({
        key: "symbol_distribution",
        label: "Symbol concentration: max single ≤ 10%; top-10 ≤ 25%; ≥ 30 distinct symbols",
        status: maxSingleOk && top10Ok && distinctOk ? "PASS" : "FAIL",
        value: `${tf}: distinct=${list.length} top1=${top1 ? toStr(top1.signal_symbol) : "-"}(${top1Events}) top10_share=${total > 0 ? ((top10Events / total) * 100).toFixed(1) : "0"}%`,
      });
    }
    // Temporal continuity criterion (per evaluated timeframe, stale rate).
    for (const tf of EVALUATED_TIMEFRAMES) {
      const staleRow = staleRows.find((r) => toStr(r.timeframe) === tf);
      const valid = staleRow ? toNum(staleRow.valid_price_ref_events) : 0;
      const stale = staleRow ? toNum(staleRow.stale_events) : 0;
      const staleRate = valid > 0 ? (stale / valid) * 100 : 100;
      criteria.push({
        key: "temporal_continuity",
        label: "Max candle gap ≤ 2× interval (≤ 4× low-liquidity); stale rate ≤ 2%",
        status: staleRate <= 2 ? "PASS" : "FAIL",
        value: `${tf}: stale_rate=${staleRate.toFixed(2)}% (valid=${valid} stale=${stale})`,
      });
    }

    console.log("\n========== 7. FROZEN PHASE 6 CRITERIA — EVALUATION ==========");
    for (const c of criteria) {
      console.log(`CRITERION ${c.key}: ${c.status} — ${c.label} | ${c.value}`);
    }

    // ============ 8. REPRODUCIBILITY ============
    const fingerprint = await sha256File(DATABASE_PATH);
    console.log("\n========== 8. REPRODUCIBILITY ==========");
    console.log(`current dataset fingerprint: ${fingerprint}`);
    console.log(`phase6 locked dataset fingerprint: ${LOCKED_DATASET_FINGERPRINT}`);
    console.log(`phase6 lock timestamp: ${LOCKED_AT}`);

    // ============ 9. COMPARISON WITH PREVIOUS DATASET (PRE-EXTENSION) ============
    console.log("\n========== 9. COMPARISON WITH PREVIOUS DATASET (PRE-EXTENSION) ==========");
    console.log("previous candle counts by timeframe: 5m=15015, 15m=9486, 30m=8132, 1h=7419, 4h=6888, 1d=6754");
    console.log("previous strict-eligible events: 5m=3129, 15m=1763, 30m=965, 1h=580, 4h=1662");
    console.log("current candle counts by timeframe: 5m=19296, 15m=12864, 30m=12864, 1h=11256, 4h=12060, 1d=33433");
    console.log("current strict-eligible events: 5m=3196, 15m=1806, 30m=1068, 1h=682, 4h=2947");

    console.log("\n========== PHASE 6 CONSOLIDATED READINESS REPORT COMPLETED ==========");
  } finally {
    db.closeSync();
  }
}

main().catch((error) => {
  console.error("Phase 6 consolidated readiness report failed:", error);
  process.exitCode = 1;
});
