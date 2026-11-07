# Phase 7 — Operational Strategy Specification (Adopted)

**Status:** Adopted — 2026-11-07 (from signal-usage guidance / screenshot)
**Related documents:** `PHASE-4-STRATEGY-SPEC.md` (frozen — retained as historical research documentation), `PHASE-6-SAFEGUARDS.md` (frozen protocol), `PHASE-6-DATASET-READINESS.md` (frozen thresholds)
**Stage:** Phase 7 (paper trading / operational reliability) — **in progress** (paper session started 2026-11-07; launched without awaiting Phase 6 formal acceptance, per the adopted strategy)

---

## 1. Decision

The signal-usage guidance (screenshot) is **adopted as the Phase 7 operational strategy**.

- **Primary trading timeframes:** `1h`, `5h`, `1d` — emphasized for entries and exits.
- **Short-term monitoring timeframes:** `5m`, `15m`, `30m` — used for market-change monitoring only.

The frozen Phase 4 strategy specification is **retained as historical research documentation** and is **not modified**.

---

## 2. Operational Timeframe Hierarchy

| Level | Timeframes | Function |
| --- | --- | --- |
| Primary (trade direction authority) | `1h`, `5h`, `1d` | Trade signals originate here; entries are taken and exits (reversals) are triggered here |
| Monitoring (market state) | `5m`, `15m`, `30m` | Monitor market direction / state changes; inform primary-timeframe decisions |

**Operational reading:** the higher timeframes (`1h`, `5h`, `1d`) define the trading bias and the entry/exit decisions; lower timeframes (`5m`, `15m`, `30m`) are chart references used to observe the latest market movement and potential direction changes.

---

## 3. Operational Entry Rules (Phase 7)

| Rule | Operational rule | Source consistency |
| --- | --- | --- |
| Trigger | Directional transition on the primary timeframe (`BUY`/`STRONG_BUY` → long; `SELL`/`STRONG_SELL` → short) | Consistent with Phase 4 signal selection |
| Confirmation delay | After a signal change, wait a minimum of **5 minutes** (or a few pips) to confirm the market direction change before entering | Consistent with Phase 4 E2 (fixed 5-minute delayed entry) |
| Entry price | First available candle close after the delay ends (`close_time > wait_end`) | Retained from Phase 4 E2 mechanics |
| Freshness | Only FRESH observations (`close_time <= observed_at`, delay <= candle interval) | Retained from Phase 4 |

---

## 4. Operational Exit Rules (Phase 7)

| Rule | Operational rule | Source consistency |
| --- | --- | --- |
| Exit | Close existing position when the **primary timeframe signal reverses** to the opposite direction; open a new position in the opposite direction | Retained from Phase 4 position lifecycle (reversal exit) |

---

## 5. Operational Monitoring / State Machine (Phase 7)

**Example (primary `1h` = Strong SELL):** the operator looks into the signals table across the lower timeframes.

| 5M | 15M | 30M | Future |
| :- | :-- | :-- | :------------------------------- |
|    |     |     | You can sell your order          |
|    |     |     | Normal - Keep your order         |
|    |     |     | Wait - market is changing        |
|    |     |     | Again - market in sell direction |
|    |     |     | Alert - close SELL order         |

**Operational interpretation:**

- Do not trade on the basis of the `5m`, `15m`, or `30m` timeframe alone if following the `1h` or `5h` timeframe; also focus on the `5m`/`15m` charts, which tell the latest market direction — because if the market direction changes, the `5m` and `15m` timeframes will effect first.
- Keep in mind that the market direction can change at any time; it never goes in one direction all the time.
- Use the monitoring states to manage position lifecycle (hold / wait / reverse / close).

---

## 6. Risk Usage Rules (Phase 7) — from signal guidance

- Signals are for **practice** purposes; demo account recommended; live use is at own risk; no liability for losses.
- Do not trade on the basis of the `5m`, `15m`, and `30m` minute chart.
- After a new signal or when the currency direction changes from Buy to Sell, wait a minimum of **5 minutes** or a few pips so it can be confirmed that the market direction has changed to the new direction.
- Market direction can change at any time; it can change after a few seconds or after a few hours.
- Mondays and Fridays are not good days for trading, especially if the trader is a beginner.
- Manual trades are always best; before live trading, must learn about RSI, STOCH, STOCHRSI, MACD, ADX, and CCI and check the chart before trading.

---

## 7. Conflict Resolution with the Frozen Phase 4 Specification

| Aspect | Phase 7 operational strategy (adopted) | Phase 4 frozen research spec | Resolution |
| --- | --- | --- | --- |
| Primary timeframe set | `1h`, `5h`, `1d` | All six timeframes eligible (`5m`, `15m`, `30m`, `1h`, `4h`, `1d`) | Phase 7 operational hierarchy reframes primary vs. monitoring; Phase 4 retained as historical research doc. Research evaluations under the Phase 4 universe remain valid as historical research. |
| Short-term monitoring | `5m`, `15m`, `30m` | All six timeframes eligible | Monitoring-only in operational use; Phase 4 kept as research spec. |
| Entry delay | Min 5 min / few pips after signal change | E2: fixed 5-minute delayed entry | **Consistent** — retained. |
| Exit / reversal | Close on primary signal direction change | Reversal exit on main timeframe | **Consistent** — retained. |

**Conclusion:** no rule change is required for entry delay or reversal exit; the adopted Phase 7 strategy re-frames the timeframe hierarchy (primary vs. monitoring) without altering the frozen entry/exit mechanics.

---

## 8. Implications

- Phase 6 out-of-sample research results were produced under the Phase 4 research universe (all six timeframes eligible; preliminary backtest used `5m/15m/30m` primary, `1h` secondary, `4h` diagnostic).
- The Phase 7 operational strategy (`1h/5h/1d` primary) may not be directly covered by those results; any operational-strategy evaluation must go through its own frozen protocol (later qualification via Phase 5 backtester, Phase 6 out-of-sample, Phase 7 paper trading).

---

## 9. Next Actions

1. Keep Phase 4 specification untouched (frozen).
2. Keep Phase 6 safeguards untouched (frozen).
3. Complete dataset readiness for a new Phase 6 evaluation (current extended dataset under review).
4. Run the Phase 7 one-week paper trading session under this operational strategy (started 2026-11-07; Phase 6 formal acceptance was **not** required for launch).

**Phase 7 is now executing.** At expiry: final liquidation of open positions with a fresh price, final performance report, then review before any real-money trading decision.
