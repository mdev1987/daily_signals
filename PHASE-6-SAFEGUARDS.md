# Phase 6 — Out-of-Sample Validation Safeguards

**Status:** Ready — must not be modified after first results are visible.

---

## 1. Dataset Preservation (Locked Before Testing)

| Element | Requirement | Phase 6 Lock (2026-11-04) |
|---|---|---|
| Historical data | Exact `data/signals.duckdb` file; no updates after lock | `data/signals.duckdb`, SHA-256 `fcc8504ac77b208549295dd63ff254984696f8ea293036cce30fda36ee7cbc55`, locked at `2026-11-04T04:01:35Z UTC` after `oxmgr stop daily-signals` (writer stopped; no active writer at lock) |
| Date boundaries | Development period, validation period, final untouched test period — defined chronologically | Frozen observation window: `2026-11-02T19:39:37Z` → `2026-11-04T03:56:12Z` (min/max across `signal_history` / `signal_snapshots`); full window designated for Phase 6 first run pending final split decision |
| Symbol universe | Fixed list of canonical instruments; no additions or removals | 153 symbols observed in `signals`; canonical mapping applied via Biquote mapping layer; fixed for this run |
| Data fingerprint | Checksum or version identifier recorded before any evaluation | `fcc8504ac77b208549295dd63ff254984696f8ea293036cce30fda36ee7cbc55` (SHA-256 of `data/signals.duckdb`) |
| Lock timestamp | Recorded; dataset frozen at this point | `2026-11-04T04:01:35Z UTC` (after service stop; DB writer inactive) |

**Rule:** Once the dataset fingerprint is recorded, any change to the database invalidates the out-of-sample evaluation.

**Lock status:** ✅ Recorded 2026-11-04 (Phase 6 entry; service stopped before hash computation; no writes after lock).

---

## 2. Acceptance Criteria (Locked Before Testing)

These criteria must be defined and recorded before any Phase 6 results are examined:

| Criterion | Requirement |
|---|---|
| Minimum sample size | Per-timeframe, per-signal minimum number of completed trades |
| Performance threshold | Net return must exceed a predefined minimum after moderate costs |
| Drawdown limit | Maximum acceptable peak-to-trough equity decline |
| Consistency | Positive results must be distributed across instruments, not concentrated |
| Robustness | Strategy must remain viable under stress cost scenario |
| Statistical reliability | Results must survive symbol-level and time-block resampling |

**Rule:** Acceptance criteria cannot be adjusted after results are visible. If results fail, the conclusion is that the strategy does not meet the predefined standard — not that the standard should be changed.

---

## 3. Risk Scenario Lock

The three predefined scenarios from Phase 4 must be preserved exactly:

| Scenario | Transaction Cost | Slippage | Position Size | Max Exposure | Max Positions |
|---|---|---|---|---|---|
| Baseline | 0% | 0% | 100% | 100% | 10 |
| Moderate | 0.05% | 0.02% | 10% | 50% | 3 |
| Stress | 0.15% | 0.05% | 5% | 25% | 2 |

**Rule:** Scenario definitions are frozen. No parameter adjustments after evaluation begins.

---

## 4. Evaluation Protocol (Locked Before Testing)

| Protocol Element | Requirement |
|---|---|
| Metrics | Total return, net profit, win rate, profit factor, expectancy, max drawdown, avg win/loss, Sharpe, Sortino, exposure, trade count |
| Cost assumptions | Gross and net reported separately; moderate scenario is the primary benchmark |
| Missing data handling | Incomplete horizons are not losses; coverage and performance reported separately |
| Reproducibility | Same dataset + same frozen config + same scenarios = identical results |
| Reporting format | Per-timeframe, per-signal, per-symbol breakdown; gross vs. net comparison |

---

## 5. Strategy Integrity (Locked Before Testing)

The frozen Phase 4 specification (`PHASE-4-STRATEGY-SPEC.md`) must be verified before each Phase 6 run:

- `verifyFrozenSpec()` must return `true`
- No changes to signal rules, entry conditions, or evaluation criteria permitted
- E4 excluded; E3 deferred; E2 entry delay fixed at 300,000ms
- Canonical symbol mapping enforced

---

## 6. Phase 6 Run Record

Every Phase 6 evaluation must be recorded with:

| Record Field | Description |
|---|---|
| Run ID | Unique identifier |
| Timestamp | When evaluation started |
| Dataset fingerprint | Checksum/version of `data/signals.duckdb` |
| Frozen spec version | Reference to `PHASE-4-STRATEGY-SPEC.md` |
| Risk scenarios used | Baseline, moderate, stress |
| Date boundaries | Development, validation, test periods |
| Symbol universe | Fixed list |
| Results | Metrics per scenario |
| Acceptance criteria met | Yes/No per criterion |
| Conclusion | Whether strategy passes out-of-sample validation |

### Phase 6 Run Record — Run 1 (2026-11-04)

| Record Field | Value |
|---|---|
| Run ID | Phase6-Run1-20261104-0410 |
| Timestamp | 2026-11-04T04:10:00Z UTC (started after Phase 6 lock; DB frozen) |
| Dataset fingerprint | `fcc8504ac77b208549295dd63ff254984696f8ea293036cce30fda36ee7cbc55` (`data/signals.duckdb`) |
| Frozen spec version | `PHASE-4-STRATEGY-SPEC.md` (E2 entry, frozen rules) |
| Risk scenarios used | Baseline, Moderate, Stress (Phase 5 `RISK_SCENARIOS`) |
| Date boundaries | Frozen observation window: `2026-11-02T19:39:37Z` → `2026-11-04T03:56:12Z` |
| Symbol universe | 153 symbols (canonical Biquote mapping applied); run executed on EUR/USD only (all generated trades) |
| Results | Baseline: 10 closed trades (mark-to-market), winRate 0.10, net -0.045, gross return -0.0000045. Moderate: 3 closed, winRate 0.33, net -0.0081. Stress: 2 closed, winRate 0.5, net -0.0048. All closed via end-of-data mark-to-market; no exit-rule-triggered closes. |
| Acceptance criteria met | See §7 — No (preliminary single run; small closed-sample) |
| Conclusion | Strategy did not pass out-of-sample validation (preliminary run 1) |

**Rule:** All records preserved; no deletion or modification after results are visible.

---

## 7. Phase 6 Conclusion Criteria

Before considering Phase 7 (Live Paper Trading), the strategy must demonstrate:

1. Positive net results after moderate costs on untouched test data
2. Acceptable drawdown (below predefined limit)
3. Consistency across instruments and timeframes
4. Stable behavior under stress scenario
5. Reproducible results (same data = same output)
6. All Phase 6 run records preserved and unmodified

**Important:** A positive out-of-sample result does not guarantee future profitability. It only establishes that the strategy's historical edge is not purely an in-sample artifact.

---

## Final Distinction: Preservation, Execution, Interpretation

These three must remain separate:

**Preservation (locked before any run):**
- Dataset fingerprint, date boundaries, symbol universe
- Acceptance criteria (minimum sample, thresholds, drawdown limits, consistency, robustness)
- Risk scenarios (baseline, moderate, stress)
- Frozen specification (`verifyFrozenSpec()` must return `true`)
- Evaluation protocol (metrics, cost assumptions, missing-data rules)

**Execution (recorded for every run):**
- Exact inputs: dataset fingerprint, frozen spec version, scenario, date boundaries
- Exact outputs: all metrics, per-timeframe/per-signal/per-symbol results, gross vs. net
- Any failure (incomplete dataset, missing candles, rejected entries) recorded as-is — not silently corrected
- No parameter or threshold changes between runs

**Interpretation (applied only after execution is complete):**
- Results classified against predefined acceptance criteria — not judged by appearance
- If criteria fail: conclusion is "strategy does not meet predefined standard"
- If criteria pass: conclusion is "strategy passes out-of-sample validation" — not "strategy is profitable"
- No profitability claim warranted until Phase 7 (paper trading) confirms operational reliability

**Rule:** If a dataset is incomplete or a run fails, record the failure. Do not change the dataset, protocol, or criteria to make the evaluation succeed.

---

## 9. Next Action

Proceed to Phase 6 evaluation using the frozen dataset, frozen specification, predefined scenarios, and locked acceptance criteria. Do not adjust any parameter, threshold, or criterion after the first results are examined.
