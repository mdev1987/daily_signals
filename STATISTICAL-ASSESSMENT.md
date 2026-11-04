# Statistical Assessment — E1 vs E2 (Corrected Canonical Results)

**Date:** 2026-11-04
**Status:** Consolidation of corrected E1/E2 findings (post canonical-symbol fix).
**Scope:** Read-only analysis. No strategy, collector, schema, or E1/E2 entry logic changed.

---

## 1. Background

The initial E1/E2 evaluation suffered from a symbol-identity bug: signal transitions
were keyed by the signal-side symbol while forward-return lookups used canonical
Biquote instrument names. The mismatch caused forward observations to be lost.

After the canonical mapping fixes (`aa94c7f`, `ebb1518`), forward coverage and
performance became real again.

---

## 2. Coverage (corrected)

| Timeframe | E1 entries | E1 with future candle | E1 complete 24-bar horizon | E2 entries | E2 with future candle | E2 complete 24-bar horizon |
|---|---:|---:|---:|---:|---:|---:|
| 5m | 1299 | 1257 (96.8%) | 900 (69.3%) | 1254 | 1228 | 849 |
| 15m | — | 880 | 18 | — | 811 | 0 |
| 30m / 1h / 4h / 1d | — | declining | declining | — | declining | declining |

Coverage decreases with timeframe, consistent with a relatively short observation window.

**Interpretation:** The earlier apparent "no forward data" problem was a data-identity bug,
not insufficient market data.

---

## 3. Performance (corrected)

Representative E1 results (direction-adjusted, gross):

| Timeframe / signal | Horizon | n | Hit rate | Mean return | MFE | MAE |
|---|---:|---:|---:|---:|---:|---:|
| 5m BUY | 1 | 284 | 50.4% | -0.0032% | 0.0173% | 0.0189% |
| 5m BUY | 24 | 211 | 47.9% | -0.0044% | 0.0930% | 0.0914% |
| 5m STRONG_SELL | 1 | 353 | 59.8% | +0.0082% | 0.0293% | 0.0167% |
| 5m STRONG_BUY | 1 | 341 | 57.5% | +0.0011% | 0.0213% | 0.0182% |
| 15m STRONG_BUY | 1 | 173 | 69.4% | — | — | — |
| 30m STRONG_BUY | 1 | 83 | 69.9% | — | — | — |
| 30m STRONG_SELL | 1 | 121 | 63.6% | — | — | — |

**Note:** Small-n subgroups (15m/30m STRONG_BUY) show high hit rates but are insufficient alone.

---

## 4. E1 vs E2 — Matched-Event Comparison (highest priority)

Compared on events eligible for both experiments (same transition, same horizon), using each
experiment's own entry price.

| Timeframe / signal | Horizon | Matched n | Mean E1 | Mean E2 | Mean diff (E1−E2) | 95% bootstrap CI of diff |
|---|---:|---:|---:|---:|---:|---:|
| 5m BUY | 1 | 278 | -0.0032% | +0.0033% | -0.0064% | [-0.0148%, +0.0009%] |
| 5m STRONG_SELL | 1 | 345 | +0.0069% | -0.0032% | +0.0100% | [+0.0030%, +0.0172%] |

Findings:
- E2 did not uniformly outperform E1 across all matched events.
- STRONG_SELL at 5m horizon showed a positive mean difference in favor of E2.
- BUY comparisons were mostly negative / inconclusive.

---

## 5. Statistical Uncertainty

- Bootstrap (2,000 resamples) for E1/E2 means and E1−E2 differences.
- Medians and hit rates computed per subgroup.
- Small subgroups (< 20 observations) flagged as insufficient evidence.

---

## 6. Pending Deliverables of the Assessment

The following were requested but not yet finalized in the committed module/docs:

- Per-symbol concentration and top-contributor exclusion analysis.
- Weekday / trading-session breakdown.
- Full cost scenarios (baseline / moderate / stress) with gross vs. net reporting.
- Final classification per timeframe/signal combination (Promising / Inconclusive / No demonstrated edge / Negative).

---

## 7. Conclusion So Far

- The corrected data resolved the forward-coverage problem.
- Signal-level performance is exploratory; hit rates alone are insufficient.
- E2 vs E1 matched comparison is mixed; E2's advantage is not universal.
- Final statistical conclusion and classification await completion of the outstanding robustness/cost analyses.

---

## 8. Next Step

Proceed to **E3** (price-confirmation / pip threshold) once the outstanding assessment items are closed, per the project roadmap.
