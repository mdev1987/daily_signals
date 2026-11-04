# Phase 4 — E2 Strategy Specification (Frozen)

**Status:** Frozen — not to be modified until Phase 5 backtester is validated.
**Based on:** Phase 1 statistical validation (E2 promising over E1) and Phase 2 E4 assessment (inconclusive, excluded).

---

## 1. Signal Selection

| Parameter | Rule |
|---|---|
| Main timeframe | 5m, 15m, 30m, 1h, 4h, 1d (all six evaluated timeframes eligible) |
| Signal states | BUY, STRONG_BUY, SELL, STRONG_SELL (directional only; NEUTRAL excluded) |
| Transition required | Previous signal ≠ current signal (transition detected) |
| Freshness | Only FRESH observations (close_time ≤ observed_at, delay ≤ candle interval) |
| Canonical symbol | All lookups use canonical Biquote instrument identity |

**Note:** Per-symbol and time-block dependence must be preserved in evaluation. Do not treat every transition as independent.

---

## 2. Entry Rules (E2 — Five-Minute Delayed Entry)

| Parameter | Rule |
|---|---|
| Trigger | Directional transition on main timeframe |
| Delay | Fixed 5 minutes (300,000 ms) after observed transition timestamp |
| Entry price | First available candle close after delay ends (close_time > wait_end) |
| Entry time | wait_end = observed_at + 300,000 ms |
| Direction | Bullish (BUY/STRONG_BUY) → long; Bearish (SELL/STRONG_SELL) → short |

**Important:** E2 is selected over E1 because Phase 1 statistical validation demonstrated E2's superiority. This does not guarantee profitability — it only establishes that the delayed entry has a stronger statistical profile than immediate entry.

---

## 3. Position Lifecycle

| Phase | Rule |
|---|---|
| Hold | Position remains open until exit condition met or maximum holding time reached |
| Reversal | If main timeframe signal reverses to opposite direction, close existing position and open new position in opposite direction |
| Exit conditions | To be defined in Phase 5 (stop-loss, take-profit, trailing stop, signal-based exit) |
| Maximum holding time | To be parameterized (not fixed yet) |

**Note:** E4 multi-timeframe state monitoring (Entry/Normal/Wait/Again/Alert) is NOT incorporated. The documented state machine did not demonstrate measurable improvement and is excluded from this specification.

---

## 4. Risk Management (Parameterized — Not Fixed)

| Parameter | Status | Notes |
|---|---|---|
| Stop-loss | Parameter to test | Not fixed; must be evaluated across scenarios |
| Take-profit | Parameter to test | Not fixed; must be evaluated across scenarios |
| Trailing stop | Parameter to test | Optional; to be tested if included |
| Position sizing | Parameter to test | Fixed fraction or fixed amount; to be tested |
| Maximum simultaneous positions | Parameter to test | To prevent overexposure |
| Maximum exposure | Parameter to test | Percentage of capital at risk |

**Important:** These are not optimized parameters. The specification defines them as testable variables to be evaluated in Phase 5, not as fixed rules selected to maximize historical returns.

---

## 5. Costs and Execution Assumptions

| Scenario | Transaction Cost | Slippage | Total Cost Assumption |
|---|---|---|---|
| Baseline | 0 | 0 | Zero (gross returns only) |
| Moderate | Reasonable estimated execution cost | Reasonable adverse slippage | Estimated per-trade cost |
| Stress | Higher execution cost | Higher adverse slippage | Stress-test cost |

**Notes:**
- Costs vary by asset class (forex, equities, commodities, crypto have different spreads/liquidity).
- Gross and net returns must be reported separately.
- A positive gross result that turns negative after costs is not a profitable strategy.

---

## 6. Evaluation Metrics and Acceptance Criteria

### Metrics (minimum)

| Metric | Purpose |
|---|---|
| Total Return | Overall account performance |
| Net Profit | Profit after modeled costs |
| Win Rate | Percentage of profitable closed trades |
| Profit Factor | Gross profit / gross loss |
| Expectancy | Average expected result per trade |
| Maximum Drawdown | Largest peak-to-trough equity decline |
| Average Win/Loss | Average size of winning and losing trades |
| Sharpe Ratio | Risk-adjusted return |
| Sortino Ratio | Downside-risk-adjusted return |
| Exposure | Percentage of time capital is committed |
| Trade Count | Number of completed trades |

### Out-of-Sample Acceptance Criteria (Phase 6)

Before considering live deployment, the strategy must demonstrate:

1. Repeatable out-of-sample performance on untouched test data
2. Positive results after realistic costs (moderate scenario)
3. Acceptable drawdown characteristics
4. Consistency across more than a small number of instruments
5. Stable behavior during different market conditions
6. Reliable paper-trading execution (Phase 7)

**Important:** A positive backtest or short paper-trading period is not sufficient evidence by itself.

---

## 7. Explicit Non-Assumptions

This specification does NOT assume:

- That E2 is profitable (only that it is statistically better than E1)
- That E4 improves results (excluded from strategy)
- That price confirmation (E3) is needed (deferred)
- That any specific parameter combination is optimal
- That results from one timeframe apply to others
- That historical performance predicts future performance

---

## 8. Freeze Declaration

This specification is frozen as of Phase 4. No changes to signal rules, entry conditions, or evaluation criteria are permitted until:

1. The backtester (Phase 5) is built and validated
2. Out-of-sample testing (Phase 6) is completed
3. Paper trading (Phase 7) demonstrates operational reliability

Only after all three stages should this specification be revised — and only if the evidence supports a change.

---

## 9. Next Action

Proceed to Phase 5 (Build the First Paper Backtester) using this frozen specification. Do not modify rules based on backtest results until out-of-sample validation is complete.

---

## 10. E3 — Price Confirmation (Frozen Research Rule)

**Status:** Frozen for the E3 research experiment (accepted 2026-11-04). The E2 entry rule above is unchanged and remains the candidate strategy entry pending the E1/E2/E3 comparison.

### 10.1 Frozen Confirmation Rule

| Signal direction   | Confirmation condition     |
| ------------------ | -------------------------- |
| BUY / STRONG_BUY   | Close ≥ reference × 1.0001 |
| SELL / STRONG_SELL | Close ≤ reference × 0.9999 |

### 10.2 Components

| Component | Requirement |
| --- | --- |
| Reference price | E1 reference entry price |
| Confirmation timing | After the E2 five-minute waiting period |
| Candle type | Closed candles only |
| Direction | Confirmation must occur in the signal direction |
| No confirmation | No E3 entry |

### 10.3 Threshold

- Fixed confirmation threshold: `0.0001` (fractional price movement).
- Accepted as final for the E3 research experiment; no historical-performance-based adjustment.
- Note: normalized `0.0001` is a fractional price movement and is not necessarily one conventional pip for instruments such as JPY pairs, equities, or crypto; the rule is defined as a fractional movement rather than claiming universal pip equivalence.

### 10.4 Versioned Change Record

| Version | Date | Change |
| ------- | ---- | ------ |
| 1.1 | 2026-11-04 | E3 price-confirmation research rule added (BUY ≥ ref×1.0001 / SELL ≤ ref×0.9999; threshold fixed at `0.0001`). E2 entry rule unchanged. Accepted following statistical assessment; final comparison to E1/E2 deferred until this frozen threshold was accepted. |

### 10.5 Next Action

Execute E3 with the frozen threshold, preserve output/config, compare E1/E2/E3, decide E3 inclusion, then proceed to the next validation stage (paper backtester pending).
