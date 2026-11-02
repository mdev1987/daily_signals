import { load } from "cheerio";

export type SignalType =
  | "STRONG_BUY"
  | "BUY"
  | "NEUTRAL"
  | "SELL"
  | "STRONG_SELL";

export interface Signal {
  symbol: string;
  timeframe: string;
  signal: SignalType;
}

const SIGNAL_MAP: Record<string, SignalType> = {
  "strong buy": "STRONG_BUY",
  buy: "BUY",
  neutral: "NEUTRAL",
  sell: "SELL",
  "strong sell": "STRONG_SELL",
};

export function parseSignals(html: string, timeframe: string): Signal[] {
  const $ = load(html);
  const signals = new Map<string, Signal>();

  $(".single_signal").each((_, element) => {
    const row = $(element);

    const symbol = row.find(".symbol a").first().text().trim();

    const rawSignal = row
      .find(".signals a")
      .first()
      .text()
      .trim()
      .toLowerCase();

    const signal = SIGNAL_MAP[rawSignal];

    if (!symbol || !signal) return;

    // بعضی نمادها در بخش Top 8 و All Pairs تکرار شده‌اند.
    if (!signals.has(symbol)) {
      signals.set(symbol, {
        symbol,
        timeframe,
        signal,
      });
    }
  });

  return [...signals.values()];
}
