export const BASE_URL = "https://massyart.com/ringsignal/inv";

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 300_000);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 10_000);

export const BIQUOTE_BASE_URL = "https://biquote.io/api";
export const BIQUOTE_MAPPING_FILE =
  process.env.BIQUOTE_MAPPING_FILE ?? "data/biquote-mapping.csv";

export const PRICE_POLL_INTERVAL_MS = Number(
  process.env.PRICE_POLL_INTERVAL_MS ?? 300_000,
);
export const PRICE_REQUEST_CONCURRENCY = Number(
  process.env.PRICE_REQUEST_CONCURRENCY ?? 4,
);
export const PRICE_CANDLE_LIMIT = Number(process.env.PRICE_CANDLE_LIMIT ?? 20_000);

export const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN?.trim();
export const TELEGRAM_CHAT_ID = process.env.CHAT_ID?.trim();
export const TELEGRAM_ENABLED =
  process.env.TELEGRAM_ENABLED !== "false" &&
  Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
export const TELEGRAM_NOTIFY_STARTUP =
  process.env.TELEGRAM_NOTIFY_STARTUP !== "false";

export const TOR_ENABLED = process.env.TOR_ENABLED !== "false";

export const ALPACA_PAPER = process.env.ALPACA_PAPER !== "false";
export const ALPACA_BASE_URL =
  process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets/v2";
export const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID?.trim() ?? "";
export const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY?.trim() ?? "";

export const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
export const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
export const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

export const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/signals.duckdb";

// Phase 7 — one-week paper trading parameters (see PHASE-7-PAPER-TRADING.md).
export const PAPER_STARTING_BALANCE = Number(
  process.env.PAPER_STARTING_BALANCE ?? 1_000,
);
export const PAPER_TRADING_DURATION_MS = Number(
  process.env.PAPER_TRADING_DURATION_MS ?? 7 * 24 * 60 * 60 * 1_000,
);
export const PAPER_PRICE_TIMEFRAME = process.env.PAPER_PRICE_TIMEFRAME ?? "5m";
export const PAPER_MAX_PRICE_AGE_MS = Number(
  process.env.PAPER_MAX_PRICE_AGE_MS ?? 15 * 60 * 1_000,
);
export const PAPER_POSITION_SIZE_PCT = Number(
  process.env.PAPER_POSITION_SIZE_PCT ?? 2,
);
export const PAPER_MAX_EXPOSURE_PCT = Number(
  process.env.PAPER_MAX_EXPOSURE_PCT ?? 50,
);
export const PAPER_MAX_OPEN_POSITIONS = Number(
  process.env.PAPER_MAX_OPEN_POSITIONS ?? 5,
);
export const PAPER_STOP_LOSS_PCT = Number(process.env.PAPER_STOP_LOSS_PCT ?? 2);
export const PAPER_TAKE_PROFIT_PCT = Number(
  process.env.PAPER_TAKE_PROFIT_PCT ?? 4,
);
export const PAPER_FEE_PCT_PER_SIDE = Number(
  process.env.PAPER_FEE_PCT_PER_SIDE ?? 0.05,
);
export const PAPER_SLIPPAGE_PCT_PER_SIDE = Number(
  process.env.PAPER_SLIPPAGE_PCT_PER_SIDE ?? 0.02,
);
export const PAPER_ENTRY_CONFIRMATION_MS = Number(
  process.env.PAPER_ENTRY_CONFIRMATION_MS ?? 5 * 60 * 1_000,
);

export const TIMEFRAMES = [
  { name: "5m", time: 300 },
  { name: "15m", time: 900 },
  { name: "30m", time: 1800 },
  { name: "1h", time: 3600 },
  { name: "4h", time: 14400 },
  { name: "5h", time: 18000 },
  { name: "1d", time: 86400 },
  { name: "1w", time: 604800 },
] as const;
