export const BASE_URL = "https://massyart.com/ringsignal/inv";

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 1_200);

export const BIQUOTE_BASE_URL = "https://biquote.io/api";
export const BIQUOTE_MAPPING_FILE =
  process.env.BIQUOTE_MAPPING_FILE ?? "data/biquote-mapping.csv";

export const PRICE_POLL_INTERVAL_MS = Number(
  process.env.PRICE_POLL_INTERVAL_MS ?? 300_000,
);
export const PRICE_REQUEST_CONCURRENCY = Number(
  process.env.PRICE_REQUEST_CONCURRENCY ?? 4,
);
export const PRICE_CANDLE_LIMIT = Number(
  process.env.PRICE_CANDLE_LIMIT ?? 100,
);

export const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN?.trim();
export const TELEGRAM_CHAT_ID = process.env.CHAT_ID?.trim();
export const TELEGRAM_ENABLED =
  process.env.TELEGRAM_ENABLED !== "false" &&
  Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
export const TELEGRAM_NOTIFY_STARTUP =
  process.env.TELEGRAM_NOTIFY_STARTUP !== "false";

export const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID!;
export const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY!;

export const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

if (!FINNHUB_API_KEY) {
  throw new Error("FINNHUB_API_KEY is missing from .env");
}

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
