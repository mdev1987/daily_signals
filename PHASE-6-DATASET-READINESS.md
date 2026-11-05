# Phase 6 — Dataset Readiness Protocol

**Status:** Approved — formally approved with clarifications; thresholds frozen as minimum dataset-readiness requirements (2026-11-05) before any new Phase 6 evaluation.

---

## 1. Purpose

Define predefined dataset-readiness criteria that the next Phase 6 out-of-sample dataset must satisfy before a new independent evaluation is executed.

These criteria are established **before** new evaluation outcomes are examined, so that the transition from:

- “insufficient data” → “adequate data”

is decided by predefined, frozen standards — not by convenience, elapsed time, or the sheer number of accumulated snapshots.

---

## 2. Readiness Dimensions and Approved Thresholds

| # | Dimension | What is measured | Approved threshold |
|---|---|---|---|
| 1 | Observation period | Price-candle history coverage per timeframe; date span of observations | ≥ 30 calendar days of candle history per evaluated timeframe |
| 2 | Event sample | Number of usable (FRESH) signal events per timeframe and direction | ≥ 30 usable events per timeframe; ≥ 15 per direction (E1/E2 comparator) |
| 3 | Join coverage | Fraction of signals with a valid candle join (symbol + timeframe present in `price_candles`) | ≥ 95% valid joins; ≤ 5% invalid joins |
| 4 | Symbol distribution | Concentration of events across instruments | Max single symbol ≤ 10%; top-10 symbols ≤ 25%; ≥ 30 distinct symbols |
| 5 | Temporal continuity | Maximum candle gap; stale observations | Max gap ≤ 2× interval (≤ 4× low-liquidity); stale rate ≤ 2% |
| 6 | Independence | Overlapping / repeated observations | Non-overlapping holding windows; dedupe repeated episodes |
| 7 | Data integrity | Candle OHLC validity, duplicates, timestamp validity | Valid OHLC, no duplicates, aligned timestamps |

**Rules:**

- Numerical thresholds were **approved as minimum dataset-readiness requirements** (2026-11-05) and are frozen.
- A dataset that fails a readiness dimension is **not** evaluated — collection continues until the predefined threshold is met.

---

## 3. Clarifications (User-Approved, 2026-11-05)

### A. Minimum sample is not statistical sufficiency.

The approved minimums (≥30 events per timeframe; ≥15 per direction) are **dataset-readiness gates**, not proof of a reliable trading edge.

The subsequent statistical assessment must still report:

- Confidence intervals.
- Effective independent sample size.
- Event clustering and dependence.
- Results by timeframe and direction.
- Uncertainty where samples remain small.

### B. Independence definition.

- Apply non-overlapping holding windows to repeated events for the same symbol and strategy exposure.
- Do **not** automatically treat simultaneous signals on different symbols as duplicates.
- Cross-symbol dependence must still be considered in statistical inference.

### C. Symbol concentration denominator.

- Calculate the 10% and 25% concentration limits using **eligible, deduplicated events** — not raw snapshots or total database rows.

  This prevents a heavily sampled symbol from distorting the readiness assessment.

---

## 4. Formal Approval and Scope Distinction

**Formal approval (2026-11-05):** Approved with clarifications. Numerical thresholds approved as minimum dataset-readiness requirements.

The protocol explicitly distinguishes three questions:

1. **Dataset readiness:** Is the data sufficiently complete and representative to conduct the research?
2. **Statistical adequacy:** Is there sufficient independent evidence to make meaningful comparisons?
3. **Strategy acceptance:** Does the frozen strategy satisfy the predefined Phase 6 performance and risk criteria?

**Rule:** Passing dataset readiness does not imply passing statistical adequacy or strategy acceptance.

---

## 5. Readiness Protocol (Frozen Steps)

1. Freeze dataset-readiness criteria — done (this document).
2. Continue passive collection.
3. Run periodic readiness audits.
4. Wait until all applicable readiness requirements pass.
5. Conduct event-level statistical research.
6. Freeze the new Phase 6 evaluation protocol before examining new performance outcomes.
7. Lock a new dataset and execute the evaluation.

---

## 6. Current Checkpoint (Informational — Pending Compliance)

Latest dataset-readiness report (live `data/signals.duckdb`):

| Metric | Latest value |
|---|---|
| Signals | 1,224 rows / 153 symbols |
| Signal history events | 13,453 / 132 symbols |
| Snapshots | 631,125 / 153 symbols |
| Candle coverage (5m–1d) | 67 symbols with candles each; tens of thousands of candles per timeframe |

Compliance against the approved thresholds is pending the accumulation of sufficient passive data. No compliance verdict here substitutes for the frozen protocol.

---

## 7. Audit Outcome Classification

Every readiness audit must classify its result into exactly one of:

| Outcome | Meaning |
|---|---|
| `NOT_READY` | Dataset requirements are not satisfied. Collection continues; no research or evaluation may proceed. |
| `READY_FOR_STATISTICAL_RESEARCH` | Dataset requirements pass, but statistical adequacy is not established. |
| `READY_FOR_PHASE_6` | Dataset and statistical requirements have both been satisfied, and the evaluation protocol is frozen. |

**Rule:** A successful data audit is never by itself authorization to evaluate or deploy the strategy. Interpretation requires the subsequent statistical assessment.

---

## 8. Next Actions and Decision Standing

1. Commit the clarified protocol — done (`20539f0`).
2. Continue passive collection — active.
3. Run periodic readiness audits — ready.
4. Wait until all applicable readiness requirements pass.
5. Conduct event-level statistical research.
6. Freeze the new Phase 6 evaluation protocol before examining new performance outcomes.
7. Lock a new dataset and execute the evaluation.

**Phase 7 remains held.**

**Decision standing:** strategy frozen · backtester synthetically validated · thresholds approved & clarified · collection active · Phase 6 Run 1 failed acceptance (preserved) · Phase 7 held.
