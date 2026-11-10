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
| Starting virtual balance | $1,000 (configurable via `PAPER_STARTING_BALANCE`) |
| Position size | 2% of current realized balance |
| Maximum open positions | 5 |
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
PAPER_STARTING_BALANCE=1000
PAPER_TRADING_DURATION_MS=604800000
PAPER_PRICE_TIMEFRAME=5m
PAPER_MAX_PRICE_AGE_MS=900000
PAPER_POSITION_SIZE_PCT=2
PAPER_MAX_EXPOSURE_PCT=50
PAPER_MAX_OPEN_POSITIONS=5
PAPER_STOP_LOSS_PCT=2
PAPER_TAKE_PROFIT_PCT=4
PAPER_FEE_PCT_PER_SIDE=0.05
PAPER_SLIPPAGE_PCT_PER_SIDE=0.02
PAPER_ENTRY_CONFIRMATION_MS=300000
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

## Phase 7 rewrite notes

### Code changes

- A position now closes on an explicit opposite directional signal only. `NEUTRAL` and missing signal rows do not trigger reversal exits.
- Added a price-driven paper-trading cycle after each price collection pass. Stop/target processing, reversal checks, and already-confirmed pending entries can progress while signal polling is unavailable.
- Stop/target replay now consumes only fully closed candles and accepts an explicit cutoff. At experiment expiry, candles are replayed only up to the nominal experiment end before final liquidation.
- `completed_at` is now a terminal guard: after it exists, later signal and price cycles do not mutate paper-trading state.
- Exit fees are calculated from exit execution notional (`quantity * adverseExit`). Status reports no longer show stale/missing quotes as zero unrealized PnL.
- Trade close is committed before Telegram notification. Telegram failures are caught and do not undo or block the recorded exit.
- Daily report delivery state records `sent` or `failed`; failed delivery is retried no more than once per hour.
- Active symbol aliases are retained for signal-to-canonical resolution. Price collection separately deduplicates canonical instruments to avoid duplicate market-data requests.
- Added regression coverage for explicit directional reversal versus `NEUTRAL`.
- Added `src/deep-audit.ts` and `audit:deep` script.

### Deep audit

The audit opens the existing DuckDB file in `READ_ONLY` mode and refuses to create a new database if the path does not exist. DuckDB does not support a separate process reading the same file while another process owns a read-write connection, so briefly stop `daily-signals` for the audit and start it again afterward. This causes a short data-collection pause but does not alter database records.

Default:
```bash
bun run audit:deep
```

Explicit paths:
```bash
bun run src/deep-audit.ts ./data/signals.duckdb ./deep_audit_vps_result.txt
```

The script writes `deep_audit_vps_result.txt` and includes database inventory, Phase 7 state/timing, poll state, signal coverage, every pending entry with a diagnosis, all open positions with mark-to-market estimates and freshness, complete closed-trade ledger and recalculated performance, position/trade consistency, per-symbol 5m candle freshness, and stored report reconciliation.

The generated live audit output is not included in this archive because the uploaded source ZIP did not contain the VPS database. Run the script against the actual VPS database to create the final report.

### Validation status

- TypeScript syntax transpilation: passed for all `.ts` files in the archive.
- `bun check` / `bun test`: not run in this environment because Bun and project dependencies are not installed here. Run both on the VPS or development machine before deployment.
- No live database was opened or modified during this rewrite.
- Strategy timeframes, confirmation period, duration, stop-loss, take-profit, sizing, exposure, fees, and slippage defaults were not changed.
