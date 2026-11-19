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
| Public testnet market data | Working (144 markets) | Working (25 PERP markets) | Working (5 markets, 3 eligible perpetuals) |
| Private account reads | Working on mainnet, opt-in | Working on testnet with a subkey | Verified on testnet; the UI deployment was reset, so the account must be recreated |
| Order placement | Blocked by gates and missing testnet keys | Blocked by gates and an unfunded account | Implemented behind gates with an ownership registry; no live testnet order run yet |
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

Reads were verified on testnet. The cause of the earlier failures was a
**deployment mismatch**, not the key itself:

- The web app (`testnet.app.lighter.xyz`) talks to `api.testnet.lighter.xyz`.
- The docs reference API is `testnet.zklighter.elliot.ai`.
- Accounts, balances and API keys exist on only one of them. A key created in
  the web app is invisible to the docs host, which reports
  `couldnt find account` or `invalid signature`.

`.env` therefore pins `LIGHTER_TESTNET_BASE_URL=https://api.testnet.lighter.xyz`.
With the sub-account `281474976710647` and key index 4, `bun run lighter:account`
read 10,000 test USDC, zero positions and zero open orders.

**That account no longer exists.** The web-app testnet was reset between runs:
the account returns `{"code":29404,"message":"not found"}` and its key list is
empty, while the docs deployment still has its own accounts. Testnet is reset
periodically, so this is expected rather than a configuration bug. Create a new
account and API key in the web app, then update `LIGHTER_ACCOUNT_INDEX` and
`LIGHTER_KEY_INDEX` together with the new key pair.

`lighter:account` now separates the two failure modes on its own: it fetches the
public account state on the configured host and prints whether the account
exists, its collateral, and which key indexes are registered.

The deployment rule applies to every check: `apikeys` and `nextNonce` must be
queried on the host that matches the key. `LIGHTER_MAINNET_BASE_URL` and
`LIGHTER_TESTNET_BASE_URL` override either side, and both are validated as
absolute HTTPS URLs at startup.

Lighter also needs its signing runtime. CCXT signs with `lighter.wasm`, a 14 MB
binary that is not committed; `bun run lighter:setup` downloads it and
`wasm_exec.js` into `.cache/lighter/` (gitignored). Without it, private calls
fail with a setup instruction rather than a signer stack trace.

Take both files from `ccxt/ccxt` (`ts/src/test/static/binaries`), which is what
`lighter:setup` now does. The older `ccxt/lighter-wasm` mirror ships a signer
that predates Lighter's 48-bit market indexes, so signing a testnet order fails
with `MarketIndex is not valid` even though account reads work. The testnet
perpetuals use ids `4095` (ETH), `4096` (BTC) and `4097` (SOL).

### Lighter futures execution

`LIGHTER_EXECUTION_ENABLED=true` mirrors Phase 7 paper positions onto the
configured Lighter account. Paper trading remains authoritative:

- A confirmed paper entry becomes a **market order** (`buy` for long, `sell`
  for short) with the configured `LIGHTER_LEVERAGE` and `LIGHTER_MARGIN_MODE`.
  The position size matches the paper quantity; leverage only reduces the
  margin reserved by the venue.
- A paper exit becomes a **reduce-only** market order, so a duplicated close
  can never flip the position.
- `LIGHTER_EXECUTION_SYMBOLS` limits mirroring to markets the venue lists.
  Lighter testnet has BTC, ETH and SOL; every other paper symbol stays
  simulation-only.
- A queued reconciler closes venue positions that no longer exist in the paper
  book, which covers a crash between the paper commit and the venue order.

Lighter signs a worst acceptable price into every order, including market
orders. The bridge uses the best quote on the relevant side plus
`LIGHTER_WORST_PRICE_SLIPPAGE_PCT`, falling back to the other side and then the
last trade, because the testnet book is often one-sided.

All order gates still apply: `TRADING_MODE=live`, `LIVE_TRADING_ENABLED=true`,
`LIGHTER_ORDER_SUBMISSION_ENABLED=true` and `LIGHTER_EXECUTION_ENABLED=true`.
Execution is restricted to the testnet private API; mainnet needs
`LIGHTER_ALLOW_MAINNET_EXECUTION=true`. Every order and error is written to the
`lighter_executions` audit trail.

Testnet liquidity is thin: the book often has only one side, so a market entry
can be acknowledged and then cancel unfilled. The bridge logs that outcome and
the reconciler keeps retrying closes; it never silently reports a fill.

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

# Replace a stale or truncated signer (required for testnet market ids 4095+)
LIGHTER_SIGNER_FORCE=1 bun run lighter:setup

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
LIGHTER_MAINNET_BASE_URL=https://mainnet.zklighter.elliot.ai
LIGHTER_TESTNET_BASE_URL=https://api.testnet.lighter.xyz

LIGHTER_EXECUTION_ENABLED=false
LIGHTER_LEVERAGE=5
LIGHTER_MARGIN_MODE=cross
LIGHTER_EXECUTION_SYMBOLS=BTC,ETH
LIGHTER_SIZE_MULTIPLIER=1
LIGHTER_MAX_NOTIONAL_USD=100
LIGHTER_FLATTEN_ON_SHUTDOWN=true
LIGHTER_WORST_PRICE_SLIPPAGE_PCT=1
LIGHTER_ALLOW_MAINNET_EXECUTION=false
LIGHTER_RECONCILE_INTERVAL_MS=60000

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
- **Lighter deployments:** the web app (`testnet.app.lighter.xyz`) uses
  `api.testnet.lighter.xyz`, while the docs reference API is
  `testnet.zklighter.elliot.ai`. They are separate environments: the same
  account index can exist on both with different owners and keys. Point
  `LIGHTER_MAINNET_BASE_URL` / `LIGHTER_TESTNET_BASE_URL` at the host where the
  key was created, and query `apikeys` and `nextNonce` on that same host.
- **Lighter testnet resets:** the web-app testnet is wiped periodically. Accounts
  and keys then return `29404 not found` even though the same index may still
  exist on the docs deployment. Recreate the account and key; no code change is
  required.
- **Lighter reconcile scope:** orphan positions are reconciled for symbols in
  `LIGHTER_EXECUTION_SYMBOLS` and for every symbol in the ownership registry.
  Removing a configured symbol does not strand a position the bot already owns,
  but a manual or external position is never closed.
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
a clean one-day 5m backfill for BTC and ETH. Private reads now work on testnet,
with 10,000 test USDC, after pointing the client at the web app's API host.

Paradex private reads work on testnet with a subkey. The testnet account still
needs funding before the order-lifecycle phase: it authenticates but
`/account/summary` reports `account_value: 0` and status `UNSPECIFIED`.

With public ingestion stable on three venues, the recommended next milestones
are the public WebSocket ingestor and candle-manager wiring, then funding rates
and execution costs (Phase 8). Live trading stays disabled on all venues.

### Execution safety additions

- `LIGHTER_SIZE_MULTIPLIER` (default 1) scales the paper quantity sent to the venue; `LIGHTER_MAX_NOTIONAL_USD` caps a single entry independently. A multiplier above 1 is refused at startup unless the cap is nonzero.
- `connect()` refuses a leverage whose liquidation distance is under 2x the paper stop loss, and refuses to start if the venue rejects the leverage.
- Opens are skipped (audited as `SKIPPED`) when the venue already holds a position on the symbol, has a resting order there, margin is insufficient, the balance is unavailable, leverage was not applied, or the size is below the venue minimum.
- After a fill, the venue-reported leverage is compared with the configured value; a higher value moves the ownership row to `UNWIND_PENDING` and starts a reduce-only unwind. `CLOSED` is only written once the venue confirms the position is flat; otherwise reconcile retries it. A venue that reports no leverage is logged as unverified.
- Closing orders are not assumed to fill. Each close compares the venue position before and after and records `FILLED`, `PARTIALLY_FILLED`, `UNKNOWN` or `REJECTED` with the observed fill and remaining size; ownership advances only by the confirmed fill.
- Closes are always reduce-only and are skipped when the venue has no position.

### Position ownership

The bot never closes a position it cannot prove it opened. `lighter_owned_positions`
is the registry, keyed by `paper_position_id`:

- A durable entry intent is written **before** the order is submitted. If the
  process or the database dies after the venue accepts the order, the row still
  exists. Confirmation is tracked separately from ownership
  (`INTENT` → `ACKNOWLEDGED` → `CONFIRMED`, or `UNRESOLVED` / `FAILED`).
- The fill is claimed only from an observed venue position. If that read fails,
  or the acknowledgement is lost, the row stays `PENDING` with
  `confirmation = UNRESOLVED`; the next reconcile adopts the venue position
  (sized from the venue, priced from its entry price) instead of discarding the
  trail. A `PENDING` intent with no position and no working order is closed as
  never filled.
- A zero observed fill is only treated as final when the order is terminal. An
  `open` order, or a bare acknowledgement that may still fill, keeps the row
  `PENDING`; it is never downgraded to `UNVERIFIED` while it can still produce a
  position.
- Opens are refused when the market already has a position or a resting order,
  so a size that appears after an intent is attributable to the bot's order.
- A fill of zero (thin testnet book) is stored as `UNVERIFIED`. The bridge will
  not close an `UNVERIFIED` or missing record, and reconcile treats the venue
  position as external.
- `CLOSE` and `RECONCILE_CLOSE` send at most the bot-owned remaining size. If the
  venue position is larger, the excess is left untouched; if its side does not
  match the owned side, the close is refused.
- Closed size is attributed: `bot_closed_amount` is what this bot's reduce-only
  orders measured as filled, `external_closed_amount` is size found flat on the
  venue without a bot order (manual close, another process). A close attempt
  that finds the venue already flat sends nothing and is attributed externally.
  `closed_amount` is their sum, so execution statistics do not mistake a manual
  close for a bot fill. Rows written before attribution existed are backfilled
  into `legacy_closed_amount` instead of being silently reported as zero.
- Each execution row records requested, filled, remaining and average price plus
  the order id / transaction hash (`lighter_executions`). A close is classified
  from the measured fill first, so a canceled or expired order with a partial
  fill is `PARTIALLY_FILLED`, not `REJECTED`.
- The reconciler walks symbols from the registry as well as the config, so
  removing a symbol from `LIGHTER_EXECUTION_SYMBOLS` cannot strand an owned
  position.
- On a clean shutdown, `LIGHTER_FLATTEN_ON_SHUTDOWN=true` re-reads each owned
  position and retries a reduce-only close up to three times before the client
  disconnects. A thrown order, price or position error counts as a failed
  attempt and does not stop the remaining attempts or the other owned
  positions. Pending entry intents are resolved from the venue first, so an
  unconfirmed fill is still flattened. A working entry order is cancelled (by
  order id, or the single order on the intent's side) and verified gone before
  shutdown completes; a position that filled before the cancel is adopted and
  flattened, and an order that cannot be cancelled or verified is reported as an
  unresolved pending entry rather than assumed flat. Any residual position is
  logged as an error with its symbol and size; a shutdown that could not
  flatten does not claim success. `SIGKILL`, machine failure and network loss
  cannot run this policy, which is why exchange-side stops are still required.
- At week end, every paper position is liquidated even without a fresh quote
  (last stored candle, then entry price), so the mirror is not left open.

Two consequences are deliberate:

- A position with no registry row (manual, another process, or opened before
  this table existed) is never closed. Close it by hand or use a dedicated
  sub-account for the bot.
- Because a clean shutdown flattens owned positions, restarting mid-session
  does not re-enter an open paper position. The paper book continues without a
  venue mirror for that position.

Not implemented: venue-side stop-loss/take-profit orders; stops are still
evaluated by the paper engine on closed 5m candles.

### Review archives

`bun run review:archive` writes `code-review.zip` from `git archive HEAD`.
Only tracked files are included, so `.env`, `.cache/` and `node_modules/` are
never part of an archive. Do not zip the working directory by hand: an
untracked `.env` would be included and any secret in it must then be rotated.
