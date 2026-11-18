/**
 * Timeframe helpers shared by the exchange adapters, ingestion and strategy
 * layers. Values are interval durations in milliseconds.
 */
export const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

export const SUPPORTED_TIMEFRAMES = Object.keys(TIMEFRAME_MS);

export function timeframeToMs(timeframe: string): number {
  const value = TIMEFRAME_MS[timeframe];

  if (!value) {
    throw new Error(
      `Unsupported timeframe "${timeframe}". Supported: ${SUPPORTED_TIMEFRAMES.join(", ")}`,
    );
  }

  return value;
}
