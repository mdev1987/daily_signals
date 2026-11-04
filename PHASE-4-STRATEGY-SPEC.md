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
