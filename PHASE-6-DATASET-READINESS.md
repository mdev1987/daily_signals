# Phase 6 — Dataset Readiness Protocol

**Status:** Proposed — criteria defined in advance for the next out-of-sample dataset. Pending formal freeze (sign-off) before any new Phase 6 evaluation.

---

## 1. Purpose

Define predefined dataset-readiness criteria that the next Phase 6 out-of-sample dataset must satisfy before a new independent evaluation is executed.

These criteria are established **before** new evaluation outcomes are examined, so that the transition from:

- “insufficient data” → “adequate data”

is decided by predefined, frozen standards — not by convenience, elapsed time, or the sheer number of accumulated snapshots.

---

## 2. Readiness Dimensions and Proposed Thresholds

| # | Dimension | What is measured | Proposed threshold (draft) |
|---|---|---|---|
| 1 | Observation period | Price-candle history coverage per timeframe; date span of observations | ≥ 30 calendar days of candle history per evaluated timeframe (earliest → latest candle) |
| 2 | Event sample | Number of usable (FRESH) signal events per timeframe and direction | ≥ 30 usable events per evaluated timeframe; ≥ 15 per direction for E1/E2 paired comparison |
| 3 | Join coverage | Fraction of signals with a valid candle join (symbol + timeframe present in `price_candles`) | ≥ 95% valid joins; ≤ 5% invalid joins |
| 4 | Symbol distribution | Concentration of events across instruments | Max single symbol ≤ 10% of usable events; top-10 symbols ≤ 25%; ≥ 30 distinct symbols with usable events |
| 5 | Temporal continuity | Maximum candle gap; stale observations | Max consecutive-candle gap ≤ 2× nominal interval (≤ 4× for low-liquidity pairs); stale-observation rate ≤ 2% |
| 6 | Independence | Overlapping / repeated observations | Counted observations must have non-overlapping holding windows; repeated market episodes deduped |
| 7 | Data integrity | Candle OHLC validity, duplicates, timestamp validity | `high ≥ max(open, close)`, `low ≤ min(open, close)`; no NULL OHLC; no duplicate `(symbol, timeframe, open_time)`; timestamps within 1 interval of interval boundary |

**Rules:**

- All thresholds are **proposed** and must be formally frozen before a new Phase 6 run is executed.
- A dataset that fails a readiness dimension is **not** evaluated — collection continues until the predefined threshold is met.
- Measurements are produced by the read-only report (`src/dataset-readiness.ts`); dated outputs, dataset fingerprints, and observation boundaries must be preserved.

---

## 3. Readiness Protocol

1. **Freeze dataset-readiness criteria** — adopt the thresholds defined in §2 as the formal protocol. No strategy changes.
2. **Continue passive collection** — keep `daily-signals` running as a passive data collector; monitor health.
3. **Run periodic readiness audits** — execute the report, preserve dated outputs, dataset hashes, observation boundaries.
4. **Conduct event-level statistical research** — only after the dataset meets the predefined readiness thresholds.
5. **Prepare a new Phase 6 evaluation** — freeze the protocol, lock the dataset, execute independently.

---

## 4. Current Checkpoint (Informational — Pending Freeze)

Latest dataset-readiness report (run against live `data/signals.duckdb`):

| Metric | Latest value |
|---|---|
| Signals | 1,224 rows / 153 symbols |
| Signal history events | 13,453 / 132 symbols |
| Snapshots | 631,125 / 153 symbols |
| Candle coverage (5m–1d) | 67 symbols with candles each; tens of thousands of candles per timeframe |

Compliance against the proposed thresholds is **pending formal freeze**. No compliance verdict here substitutes for the frozen protocol, and no readiness-based decision may be used to alter frozen strategy rules.

---

## 5. Next Actions

1. Formal sign-off / freeze of the thresholds in §2 (this document).
2. Continue passive collection; run periodic readiness audits.
3. When the dataset meets the frozen thresholds, proceed to statistical research → new Phase 6 evaluation.

**Decision standing:** strategy frozen · backtester synthetically validated · collection active · Phase 6 Run 1 failed acceptance (preserved) · Phase 7 held.
