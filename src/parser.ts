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

export interface ParsedSignalBatch {
  signals: Signal[];
  duplicateSymbols: string[];
  conflictingSymbols: string[];
}

export function parseSignalsWithDiagnostics(
  html: string,
  timeframe: string,
): ParsedSignalBatch {
  const $ = load(html);
  const signals = new Map<string, Signal>();
  const duplicateSymbols = new Set<string>();
  const conflictingSymbols = new Set<string>();

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

    const previous = signals.get(symbol);

    // بعضی نمادها در بخش Top 8 و All Pairs تکرار شده‌اند.
    if (previous) {
      duplicateSymbols.add(symbol);

      if (previous.signal !== signal) {
        conflictingSymbols.add(symbol);
      }

      return;
    }

    signals.set(symbol, {
      symbol,
      timeframe,
      signal,
    });
  });

  return {
    signals: [...signals.values()],
    duplicateSymbols: [...duplicateSymbols],
    conflictingSymbols: [...conflictingSymbols],
  };
}

// Keep compatibility with existing callers.
export function parseSignals(html: string, timeframe: string): Signal[] {
  return parseSignalsWithDiagnostics(html, timeframe).signals;
}
