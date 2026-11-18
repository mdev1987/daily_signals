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

## Crypto futures research engine

The research engine is exchange-agnostic. Strategy, risk and portfolio code
depend only on `src/exchanges/exchange.types.ts`; nothing outside
`src/exchanges/<venue>/` imports CCXT or a venue SDK. ApeX Omni was the first
adapter; Paradex is the second.

CCXT is the primary interface for market data and order plumbing on both
venues. `@paradex/sdk` and `ethers` are installed for wallet/account-specific
work (onboarding, key derivation) and are not part of the research path.

### Current status

| Component | ApeX Omni | Paradex |
| --- | --- | --- |
| Public mainnet market data | Working (139 markets, 89 eligible) | Working (65 PERP markets, all eligible) |
| Public testnet market data | Working (144 markets) | Working (25 PERP markets) |
| Private account reads | Working on mainnet, opt-in | Configured, blocked by account onboarding |
| Order placement | Blocked by gates and missing testnet keys | Blocked by gates and account onboarding |
| 5-minute backfill | Working; validated against live data | Working; validated against live data |
| Settlement | USDT | USDC |

A 30-day ApeX acceptance run of the default universe produced **86,400 finalized
5m candles across 10 markets** with zero gaps, duplicates, invalid rows, or
in-progress candles.

Paradex uses unified symbols such as `BTC/USD:USDC` and keeps the native
`BTC-USD-PERP` id in `exchangeSymbol`. A one-day smoke backfill of BTC and ETH
stored 189 and 120 finalized candles with zero invalid or duplicate rows.

### Private API status

The Paradex account keypair in `.env` authenticates structurally but is not
usable for reads yet:

- **Testnet:** `STARKNET_SIGNATURE_VERIFICATION_FAILED` — the supplied public
  key does not match the account registered at that address.
- **Mainnet:** `NOT_ONBOARDED` — the account has never called `/onboarding`.

Create or re-onboard the account in the Paradex portal and copy the three
account values again. Until then `PARADEX_PRIVATE_API_ENABLED` stays false and
no order can be submitted.

The ApeX testnet key remains a separate blocker: the supplied key is mainnet-only
and must be recreated in the ApeX testnet portal.


### Commands

`EXCHANGE` selects the venue for the generic commands; the prefixed scripts pin
it explicitly.

```bash
# Public market-data smoke tests (no credentials, no orders)
bun run apex:smoke
bun run paradex:smoke

# Sync market metadata into DuckDB and print the initial universe
bun run apex:markets
bun run paradex:markets

# Backfill closed 5m candles (default: last 30 days, default majors)
bun run apex:backfill
bun run paradex:backfill

# Explicit symbols, range and timeframe
bun run paradex:backfill --symbols=BTC,ETH,SOL --days=7 --timeframe=5m

# Continue a partial range / refresh the tail
bun run paradex:backfill --symbols=BTC --days=30 --timeframe=5m

# Generic form, venue chosen by EXCHANGE
EXCHANGE=paradex bun run backfill --days=1
```

The backfill is idempotent and resumable: a run whose stored range already
covers the request performs no network requests. Re-walking a partial range
upserts instead of duplicating.

### Configuration

Market data, private account access and execution are separate settings per
venue:

```env
APEX_MARKET_DATA_ENV=mainnet
APEX_PRIVATE_API_ENABLED=false
APEX_PRIVATE_API_ENV=mainnet
APEX_ORDER_SUBMISSION_ENABLED=false

PARADEX_ENV=testnet
PARADEX_MARKET_DATA_ENV=testnet
PARADEX_PRIVATE_API_ENABLED=false
PARADEX_PRIVATE_API_ENV=testnet
PARADEX_ORDER_SUBMISSION_ENABLED=false

TRADING_MODE=paper
LIVE_TRADING_ENABLED=false

OMNIAPEX_API_KEY=
OMNIAPEX_API_SECRET=
OMNIAPEX_PASS_PHRASE=
APEX_OMNI_SEEDS=

PARADEX_PRIVATE_KEY=
PARADEX_PUBLICK_KEY=
PARADEX_ADDRESS=
PARADEX_WALLET_ADDRESS=
PARADEX_EVM_PRIVATE_KEY=

RESEARCH_DATABASE_PATH=./data/research.duckdb
APEX_SYMBOLS=
APEX_UNIVERSE_SIZE=10
APEX_TIMEFRAME=5m
APEX_BACKFILL_DAYS=30
APEX_REQUEST_DELAY_MS=250
PARADEX_SYMBOLS=
PARADEX_UNIVERSE_SIZE=10
PARADEX_TIMEFRAME=5m
PARADEX_BACKFILL_DAYS=30
PARADEX_REQUEST_DELAY_MS=250
```

`APEX_SYMBOLS` and `PARADEX_SYMBOLS` accept a base asset (`BTC`), a unified
symbol (`BTC/USD:USDC`) or a native id (`BTC-USD-PERP`). Leaving them empty
selects the default majors that actually exist on the exchange.

Paradex accepts two credential shapes: the account keypair from the Paradex UI
(`PARADEX_PRIVATE_KEY`, `PARADEX_PUBLICK_KEY`, `PARADEX_ADDRESS`) or an EVM
wallet (`PARADEX_WALLET_ADDRESS`, `PARADEX_EVM_PRIVATE_KEY`) from which Paradex
derives the account. `PARADEX_PUBLICK_KEY` keeps its historical spelling so the
existing local `.env` keeps working.

`.env.example` keeps testnet for Paradex market data. The local `.env` points
market data at mainnet while private access and execution stay on testnet, so
research reads real candles without touching a production account.

An order can only be submitted when **all** of these are true:

1. `<VENUE>_ORDER_SUBMISSION_ENABLED=true`
2. `TRADING_MODE=live`
3. `LIVE_TRADING_ENABLED=true`
4. Signing material is present (`APEX_OMNI_SEEDS` for ApeX, an account keypair
   or EVM wallet for Paradex)

`assertOrderSubmissionAllowed()` and `assertParadexOrderSubmissionAllowed()`
are called before any order or cancellation. `TRADING_MODE` defaults to paper
and every other gate defaults to false.

### Layout

```text
src/exchanges/
├── exchange.types.ts        # normalized types + ExchangeAdapter
├── exchange.errors.ts
├── exchange.config.ts       # environment / boolean / trading-mode parsing
├── exchange.factory.ts      # venue selection
├── exchange.profile.ts      # per-venue universe, pagination and env names
├── market-universe.ts       # symbol matching + universe selection
├── normalizers.ts           # shared OHLCV/ticker/order normalizers
├── apex/
│   ├── apex.adapter.ts
│   ├── apex.client.ts
│   ├── apex.config.ts
│   ├── apex.market-mapper.ts
│   └── smoke-test.ts
└── paradex/
    ├── paradex.adapter.ts
    ├── paradex.client.ts
    ├── paradex.config.ts
    ├── paradex.market-mapper.ts
    └── smoke-test.ts

src/market-data/
├── historical-backfill.ts
├── backfill-cli.ts
├── candle-manager.ts
├── data-validator.ts
├── market-metadata.ts
└── timeframes.ts

src/storage/
├── database.ts
└── repositories/
    ├── market.repository.ts
    └── candle.repository.ts
```

### Storage

`research.duckdb` is separate from the Phase 7 `signals.duckdb` so a crypto
research run cannot touch live paper-trading state.

| Table | Purpose |
| --- | --- |
| `markets` | Contract specs, precision, limits, margin rates, raw payload |
| `candles` | Finalized OHLCV, keyed by `(exchange, symbol, timeframe, open_time)` |
| `ingestion_cursors` | Oldest ingested open time per series |
| `ingestion_runs` | Per-run request/insert counters and status |
| `schema_migrations` | Schema version |

Prices are stored as `DOUBLE` because the exchange client returns JavaScript
numbers; the source values are not higher-precision decimals. Duplicate
protection and validation are enforced in code and by the primary key.

### Data caveats

- **ApeX pagination:** the kline endpoint returns the most recent `limit`
  candles ending at `end`; `start` only clamps the lower edge. The backfill
  therefore walks backwards from the newest closed candle.
- **Paradex pagination:** klines are returned from `start_at` upwards, so the
  backfill walks forwards in bounded windows. A short page does not stop the
  walk because Paradex omits intervals without trades.
- **Paradex sparse candles:** only intervals that traded are returned. The data
  quality report counts those gaps and marks them expected instead of failing
  the series. Downstream research must align on `openTime`, not assume a
  contiguous array.
- **Paradex OHLC quirk:** the interval `open` carries the previous close while
  `high`/`low` cover trades inside the interval, so `open` can sit outside the
  reported range. The adapter widens `high`/`low` to contain `open` and `close`
  (both traded prices) before validation. ApeX rows stay strictly validated.
- **Paradex market list:** the unfiltered `/markets` payload is ~16 MB because
  it includes every option series. The adapter always requests
  `asset_kind=PERP`, which is ~65 KB, and retries the request with backoff.
- **Paradex timeframes:** the venue supports `1m`, `3m`, `5m`, `15m`, `30m`
  and `1h`; other timeframes are rejected before a request is made.
- The still-forming candle is never stored. `CandleManager` guarantees that a
  completed candle triggers evaluation exactly once, including after a restart.
- `getTicker()` on ApeX has last price only. Use `getOrderBook()` when a bid/ask
  is needed for execution modelling. Paradex returns bid/ask.
- CCXT's maker/taker values are documented defaults, not account-specific
  rates. They must be verified before being used in research PnL.

### Next step

Paradex account onboarding is the remaining blocker for private reads and the
order-lifecycle phase. Until it is resolved, the recommended next milestones are
the public WebSocket ingestor and candle-manager wiring, then funding rates and
execution costs (Phase 8). Live trading stays disabled on both venues.
