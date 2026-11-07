# Phase 7 — One-Week Paper Trading

## Objective

Run the existing signal receiver and price collector for seven days while executing simulated trades only. This is an operational forward test, not a claim that the strategy is profitable. Phase 6 is not a prerequisite for this experiment.

## Operational strategy

- **Entry timeframes:** `1h`, `5h`, `1d`.
- **Monitoring-only timeframes:** `5m`, `15m`, `30m`. These never create or close positions by themselves.
- `4h` and `1w` remain collected for research but are not used for Phase 7 execution.
- `BUY` / `STRONG_BUY` map to long; `SELL` / `STRONG_SELL` map to short. `NEUTRAL` creates no entry.
- A new or changed primary signal creates a pending entry. It must remain unchanged for at least five minutes before entry.
- Entries use the latest closed `5m` candle close. The candle must be no older than 15 minutes. Missing/stale prices prevent entry and do not trigger a fallback to stale data.
- Until FX conversion and CFD contract multipliers are available, only instruments whose canonical symbol is USD-quoted (symbol ends in `USD`) are eligible for portfolio accounting. Other instruments are logged and skipped.
- A reversal on a primary timeframe closes an opposing open position. Lower timeframes are logged as market-change context only; they do not independently force exits in this initial implementation.
- Existing positions are monitored using every newly stored closed `5m` candle high/low, replayed in chronological order so a delayed polling cycle does not skip intermediate candles. If both stop and target are touched in the same candle, stop-loss is assumed first (conservative ordering).
- At the end of seven days, open positions with a fresh price are liquidated at the latest `5m` close. Positions without a fresh price remain open and are explicitly included in the final report.

## Initial paper risk settings

These are an initial, predeclared test configuration, not optimized parameters:

| Setting | Value |
|---|---:|
| Starting virtual balance | $10,000 (configurable) |
| Position size | 10% of current realized balance |
| Maximum open positions | 3 |
| Maximum aggregate notional exposure | 50% of realized balance |
| Stop-loss | 2% |
| Take-profit | 4% |
| Fee assumption | 0.05% per side |
| Slippage assumption | 0.02% per side |
| Entry confirmation | 5 minutes |

Fees and slippage are modeled per side. Entry slippage is reflected in the effective entry price; exit slippage is reflected in the effective exit price. Both are also separately recorded for reporting, but are not subtracted a second time from PnL. Net PnL = gross PnL - entry fee - exit fee.

## Persistence

Phase 7 adds these DuckDB tables:

- `phase7_state`: experiment start, starting balance, completion marker, daily report markers (daily summaries use UTC calendar days).
- `paper_pending_entries`: pending confirmations, recoverable after restart.
- `paper_positions`: open positions and risk levels, recoverable after restart.
- `paper_trades`: immutable closed-trade accounting.

The experiment start time is initialized once and persists across restarts. Restarting the service does not reset the seven-day clock or virtual balance.

## Start

Set (optional):

```env
PAPER_STARTING_BALANCE=10000
```

Then run the normal receiver:

```bash
bun run start
```

The paper engine starts automatically with the receiver. It sends no broker orders and does not call Alpaca order APIs. Do not configure or enable any live-order execution for this phase.

## Review

Useful queries:

```sql
-- Closed-trade summary
SELECT COUNT(*) AS trades,
       SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS winners,
       SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END) AS losers,
       SUM(net_pnl) AS net_pnl,
       AVG(net_pnl) AS average_net_pnl
FROM paper_trades;

-- Trade ledger
SELECT * FROM paper_trades ORDER BY exit_time;

-- Still-open positions
SELECT * FROM paper_positions WHERE status = 'OPEN';

-- Experiment clock
SELECT * FROM phase7_state ORDER BY key;
```

Do not move to real-money trading solely because the seven-day PnL is positive. Review trade count, net PnL after modeled costs, drawdown, exposure, data freshness, missed/blocked entries, and whether results depend on a small number of outliers. A short sample may require extending paper trading.

## Known limitations

- This first version uses the latest closed `5m` candle as the execution-price proxy, not a live bid/ask quote or tick stream.
- Non-USD-quoted instruments are skipped because cross-currency PnL conversion is not implemented; index/CFD contract multipliers are also not modeled.
- It does not model spread independently; the slippage assumption is a simplified proxy.
- Lower-timeframe signal combinations are logged but do not yet implement the vendor's ambiguous visual alert matrix as an automatic exit rule.
- `1d` and `5h` signals use the same `5m` price proxy as `1h` signals.
- Signal baselines already present when the experiment starts do not cause immediate entries. A new primary-timeframe signal transition is required, avoiding retrospective entries on stale state.
- The experiment is not a recommendation to trade live.
