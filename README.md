# daily_signals

Receives Live Daily Signals, records signal changes and collects market prices
for a local backtest.

## Signals

The receiver polls every timeframe (`5m`, `15m`, `30m`, `1h`, `4h`, `5h`,
`1d`, `1w`) and stores the latest state, a snapshot per poll and a history of
changes in DuckDB (`data/signals.duckdb`).

## Prices

A second, independent loop collects closed OHLC candles from Biquote for every
active instrument in `data/biquote-mapping.csv`. Prices are stored in the
`price_candles` table.

- Intervals: `5m`, `15m`, `30m`, `1h`, `4h`, `1d`.
- `5h` and `1w` can be aggregated from the stored `1h` and `1d` candles.
- The primary key is `(symbol, timeframe, open_time)`, so re-fetching the same
  candle is a no-op.
- Open (incomplete) candles and invalid bars are discarded.

The price collector has its own interval and does not block signal polling.
Database writes are serialized, so both loops can run safely on one DuckDB
connection.

## Telegram alerts

Signal changes are sent to Telegram as professional MarkdownV2 messages with
icons, using `grammy` and `telegram-markdown-v2`. Notifications are fail-soft:
Telegram errors are logged and never stop signal polling or price collection.

```env
BOT_TOKEN=123456:your-bot-token
CHAT_ID=123456789
TELEGRAM_ENABLED=true
TELEGRAM_NOTIFY_STARTUP=true
```

Set `TELEGRAM_ENABLED=false` to disable sending, or
`TELEGRAM_NOTIFY_STARTUP=false` to suppress the startup message only.

## Process manager

```bash
oxmgr apply ./oxfile.toml
oxmgr logs daily-signals -f
```

The oxfile runs `bun run src/main.ts` from this directory, restarts on crashes,
checks log freshness every minute and validates dependencies before reloads.

## Usage

```bash
bun install
bun run typecheck

# One price collection pass (useful for the first history load)
bun run prices:once

# Signals + prices continuously
bun run start
```

Configuration (in `.env`):

```env
POLL_INTERVAL_MS=60000
REQUEST_DELAY_MS=1200

PRICE_POLL_INTERVAL_MS=300000
PRICE_REQUEST_CONCURRENCY=4
PRICE_CANDLE_LIMIT=100
```

`DATABASE_PATH` can override the default `./data/signals.duckdb` location.

## Phase 7 deep audit (read-only)

Run this on the VPS against the same DuckDB file used by the service:

```bash
bun run src/deep-audit.ts
```

Or pass explicit paths:

```bash
bun run src/deep-audit.ts ./data/signals.duckdb ./deep_audit_vps_result.txt
```

The script refuses to create a database when the supplied path does not exist.
It opens the database in DuckDB `READ_ONLY` mode. Because DuckDB does not support
a separate process reading the same file while another process owns a read-write
connection, briefly stop `daily-signals` before running the audit, then start it
again. This creates a short collection gap but does not alter database records.
It performs SELECT-only inspection and writes `deep_audit_vps_result.txt` with
all pending entries, open positions, the complete closed-trade ledger,
recalculated performance, price freshness, poll state, position/trade
consistency checks, and stored-report reconciliation. It does not reset or
modify the database.

Phase 7 operational strategy, one-week paper-trading implementation, and rewrite notes live in [PHASE-7-PAPER-TRADING.md](./PHASE-7-PAPER-TRADING.md).
