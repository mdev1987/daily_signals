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
adapter, Paradex the second, Lighter the third.

CCXT is the primary interface for market data and order plumbing on all three
venues. `@paradex/sdk` and `ethers` are installed for wallet/account-specific
work (onboarding, key derivation) and are not part of the research path.
`starknet` signs the Paradex auth request, and CCXT's wasm signer signs Lighter
requests.

### Current status

| Component | ApeX Omni | Paradex | Lighter |
| --- | --- | --- | --- |
| Public mainnet market data | Working (139 markets, 89 eligible) | Working (65 PERP markets, all eligible) | Working (244 markets, 209 eligible) |
| Public testnet market data | Working (144 markets) | Working (25 PERP markets) | Working (8 markets, 7 eligible) |
| Private account reads | Working on mainnet, opt-in | Working on testnet with a subkey | Blocked by mismatched credentials |
| Order placement | Blocked by gates and missing testnet keys | Blocked by gates and an unfunded account | Blocked by gates and credential mismatch |
| 5-minute backfill | Working; validated against live data | Working; validated against live data | Working; validated against live data |
| Settlement | USDT | USDC | USDC |

A 30-day ApeX acceptance run of the default universe produced **86,400 finalized
5m candles across 10 markets** with zero gaps, duplicates, invalid rows, or
in-progress candles.

Paradex uses unified symbols such as `BTC/USD:USDC` and keeps the native
`BTC-USD-PERP` id in `exchangeSymbol`. A one-day smoke backfill of BTC and ETH
stored 189 and 120 finalized candles with zero invalid or duplicate rows.

Lighter uses `BTC/USDC:USDC` and keeps the numeric market id (`1`) in
`exchangeSymbol`; base-asset requests like `BTC` resolve normally. A one-day
mainnet backfill stored **288 finalized 5m candles each for BTC and ETH**, with
zero gaps, duplicates, invalid rows or in-progress candles.

### Paradex private API status

Reads work on testnet. The key in `.env` is a **subkey**, not the account's
main key, which is why the obvious paths fail:

- `POST /v1/auth` verifies against the account's main key, so a subkey gets
  `STARKNET_SIGNATURE_VERIFICATION_FAILED`.
- `GET /onboarding?public_key=…` reports `exists: false` for subkeys because
  only main keys are registered there.
- `/v1/auth/{public_key}` is the subkey endpoint. The signed message still says
  `/v1/auth`; only the path the server verifies against changes.

`PARADEX_AUTH_MODE=auto` tries the account endpoint first and falls back to the
subkey endpoint only when the venue reports a signature verification failure.
The minted JWT is attached to the CCXT client, so every private call reuses it
and CCXT never re-signs with the wrong key. `bun run paradex:account` reports
which endpoint accepted the key.

Two other findings:

- **Mainnet private API is geo-blocked here:** requests return
  `GEO_IP_BLOCK` (`Service access restricted in your region`, country `IR`).
  Public mainnet market data is unaffected; private reads must use testnet.
- **The testnet account authenticates but is unfunded:** `/balance` is empty
  and `/account/summary` returns `account_value: 0`, `status: UNSPECIFIED`.
  New testnet accounts are credited with 1,000,000 test USDC shortly after
  creation, so this account needs funding (or a new sub-account, which is also
  credited, then a Portfolio transfer).

`PARADEX_PRIVATE_API_ENABLED` can therefore be true for reads. Order submission
still needs all of its own gates plus a funded account.

The ApeX testnet key remains a separate blocker: the supplied key is mainnet-only
and must be recreated in the ApeX testnet portal.

### Lighter private API status

The account index and API key in `.env` do not belong together:

- Testnet account **887** exists and holds **10,000 test USDC**.
- Its only registered API key is index **171** (public key `cb9c…`).
- The `.env` credentials are index **4** (public key `dd39…`).

Signing with the `.env` key at index 4 returns
`invalid auth: couldnt find account`; signing the same key at the registered
index 171 returns `invalid signature`. The key pair is structurally valid but
registered on a different account. `bun run lighter:account` prints the exact
error without printing the key.

To fix it, open the Lighter testnet UI for account 887 → **Settings → API Keys**,
create a key, and copy its index, private key and public key into `.env`. Indexes
0–3 are reserved for Lighter's own clients; automation uses 4–254, but the index
must match the key registered on that account.

Lighter also needs its signing runtime. CCXT signs with `lighter.wasm`, a 14 MB
binary that is not committed; `bun run lighter:setup` downloads it and
`wasm_exec.js` into `.cache/lighter/` (gitignored). Without it, private calls
fail with a setup instruction rather than a signer stack trace.

### Commands

`EXCHANGE` selects the venue for the generic commands; the prefixed scripts pin
it explicitly.

```bash
# Public market-data smoke tests (no credentials, no orders)
bun run apex:smoke
bun run paradex:smoke
bun run lighter:smoke

# One-time: download the Lighter wasm signer into .cache/lighter/
bun run lighter:setup

# Read-only account check (mints a token/JWT, reads balance/positions/orders)
bun run paradex:account
bun run lighter:account

# Which Paradex endpoint accepted the key? account, subkey, or auto (default)
PARADEX_AUTH_MODE=subkey bun run paradex:account

# Sync market metadata into DuckDB and print the initial universe
bun run apex:markets
bun run paradex:markets
bun run lighter:markets

# Backfill closed 5m candles (default: last 30 days, default majors)
bun run apex:backfill
bun run paradex:backfill
bun run lighter:backfill

# Explicit symbols, range and timeframe
bun run paradex:backfill --symbols=BTC,ETH,SOL --days=7 --timeframe=5m
bun run lighter:backfill --symbols=BTC,ETH --days=1 --timeframe=5m

# Continue a partial range / refresh the tail
bun run paradex:backfill --symbols=BTC --days=30 --timeframe=5m

# Generic form, venue chosen by EXCHANGE
EXCHANGE=lighter bun run backfill --days=1
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
PARADEX_AUTH_MODE=auto

LIGHTER_ENV=testnet
LIGHTER_MARKET_DATA_ENV=testnet
LIGHTER_PRIVATE_API_ENABLED=false
LIGHTER_PRIVATE_API_ENV=testnet
LIGHTER_ORDER_SUBMISSION_ENABLED=false

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

LIGHTER_PRIVATE_KEY=
LIGHTER_PUBLIC_KEY=
LIGHTER_ACCOUNT_INDEX=
LIGHTER_KEY_INDEX=

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
LIGHTER_SYMBOLS=
LIGHTER_UNIVERSE_SIZE=10
LIGHTER_TIMEFRAME=5m
LIGHTER_BACKFILL_DAYS=30
LIGHTER_REQUEST_DELAY_MS=250
```

`APEX_SYMBOLS`, `PARADEX_SYMBOLS` and `LIGHTER_SYMBOLS` accept a base asset
(`BTC`), a unified symbol (`BTC/USD:USDC` or `BTC/USDC:USDC`) or a native id
(`BTC-USD-PERP` or `1`). Leaving them empty selects the default majors that
actually exist on the exchange.

Paradex accepts two credential shapes: the account keypair from the Paradex UI
(`PARADEX_PRIVATE_KEY`, `PARADEX_PUBLICK_KEY`, `PARADEX_ADDRESS`) or an EVM
wallet (`PARADEX_WALLET_ADDRESS`, `PARADEX_EVM_PRIVATE_KEY`) from which Paradex
derives the account. `PARADEX_PUBLICK_KEY` keeps its historical spelling so the
existing local `.env` keeps working.

The keypair may be the account's main key or a **subkey**. Subkeys are the safer
choice: they can trade and read but cannot withdraw or transfer. They only work
at `/v1/auth/{public_key}`, which `PARADEX_AUTH_MODE=auto` detects. Set
`PARADEX_AUTH_MODE=account` or `subkey` to skip detection. All three values are
required: the public key is the identity the venue verifies, and the address is
the account the key belongs to.

Read-only tokens (Settings → Key Management → Read-only) are the lowest-risk
option for pure monitoring, but this adapter currently authenticates with the
keypair only.

Lighter authenticates with an **API key pair plus two integers**, not an
address: `LIGHTER_PRIVATE_KEY` (40-byte hex), `LIGHTER_PUBLIC_KEY`,
`LIGHTER_ACCOUNT_INDEX` and `LIGHTER_KEY_INDEX`. Each account and sub-account
has its own key indexes, and 0–3 are reserved for Lighter's own clients. The
key index must match the key registered on that account; copying an index from
one account while using another account's key fails with
`invalid auth: couldnt find account` or `invalid signature`.

`.env.example` keeps testnet for every venue. The local `.env` points market
data at mainnet while private access and execution stay on testnet, so research
reads real candles without touching a production account.

An order can only be submitted when **all** of these are true:

1. `<VENUE>_ORDER_SUBMISSION_ENABLED=true`
2. `TRADING_MODE=live`
3. `LIVE_TRADING_ENABLED=true`
4. Signing material is present (`APEX_OMNI_SEEDS` for ApeX, an account keypair
   or EVM wallet for Paradex, an API key with both indexes for Lighter)

`assertOrderSubmissionAllowed()`, `assertParadexOrderSubmissionAllowed()` and
`assertLighterOrderSubmissionAllowed()` are called before any order or
cancellation. `TRADING_MODE` defaults to paper and every other gate defaults to
false.

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
├── paradex/
│   ├── paradex.adapter.ts
│   ├── paradex.auth.ts        # SNIP-12 auth, subkey support, JWT refresh
│   ├── paradex.client.ts
│   ├── paradex.config.ts
│   ├── paradex.market-mapper.ts
│   ├── account-check.ts
│   └── smoke-test.ts
└── lighter/
    ├── lighter.adapter.ts
    ├── lighter.client.ts      # CCXT client + wasm signer loading
    ├── lighter.config.ts      # API key, account/key indexes, chain id
    ├── lighter.market-mapper.ts
    ├── download-signer.ts     # lighter:setup helper
    ├── account-check.ts
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
- **Paradex auth timestamps:** `PARADEX-TIMESTAMP` and
  `PARADEX-SIGNATURE-EXPIRATION` are Unix **seconds**, and the signature is a
  JSON array of **decimal** strings. Hex components are rejected as
  `INVALID_TOKEN`, which hides the real cause.
- **Paradex mainnet private API:** geo-blocked from this network
  (`GEO_IP_BLOCK`, country `IR`). Public mainnet market data still works, so
  research candles are unaffected; account reads run on testnet.
- **Lighter pagination:** like Paradex, the candle endpoint walks forwards from
  `start_timestamp`. It returns at most **500 candles per request**, so the
  adapter clamps larger requests; the shared backfill pages 200 at a time.
- **Lighter zero-volume omission:** Lighter omits zero-valued fields, so an
  interval without trades arrives without `v`. The price candle is still real;
  the adapter treats the missing volume as `0` instead of dropping the row.
  Intervals themselves are contiguous (360/360 one-minute candles for a market
  that had no trades in six hours).
- **Lighter timeframes:** the venue supports `1m`, `5m`, `15m`, `30m`, `1h`,
  `4h`, `12h` and `1d`; other timeframes are rejected before a request.
- **Lighter testnet history:** short. BTC 5m candles go back about a week, so a
  30-day request returns empty pages for the older part of the range. Use
  mainnet for research candles.
- **Lighter order price:** every order, including a market order, carries a
  price — it is the worst acceptable execution price, so it cannot be omitted.
- **Lighter funding history:** `/api/v1/fundings` reports 1h or 1d entries with
  Unix **second** timestamps; the adapter requests 1h and converts to
  milliseconds.
- The still-forming candle is never stored. `CandleManager` guarantees that a
  completed candle triggers evaluation exactly once, including after a restart.
- `getTicker()` on ApeX and Lighter has last price only. Use `getOrderBook()`
  when a bid/ask is needed for execution modelling. Paradex returns bid/ask.
- CCXT's maker/taker values are documented defaults, not account-specific
  rates. They must be verified before being used in research PnL.

### Next step

Lighter public market data is validated: 244 mainnet markets, 209 eligible, and
a clean one-day 5m backfill for BTC and ETH. Its private reads are blocked until
the API key and account index in `.env` come from the same account.

Paradex private reads work on testnet with a subkey. The testnet account still
needs funding before the order-lifecycle phase: it authenticates but
`/account/summary` reports `account_value: 0` and status `UNSPECIFIED`.

With public ingestion stable on three venues, the recommended next milestones
are the public WebSocket ingestor and candle-manager wiring, then funding rates
and execution costs (Phase 8). Live trading stays disabled on all venues.
