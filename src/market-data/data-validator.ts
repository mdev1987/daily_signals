import type { Candle } from "../exchanges/exchange.types";

export interface CandleGap {
  /** Last open time before the gap. */
  fromOpenTime: number;
  /** First open time after the gap. */
  toOpenTime: number;
  missing: number;
}

export interface CandleValidationReport {
  symbol: string;
  timeframe: string;
  timeframeMs: number;
  total: number;
  finalCandles: number;
  nonFinalCandles: number;
  invalid: number;
  duplicates: number;
  misaligned: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  missingIntervals: number;
  gaps: CandleGap[];
  gapsTruncated: boolean;
  passed: boolean;
}

export interface ValidateCandleOptions {
  /** Treat an in-progress candle as a failure. Defaults to true. */
  requireFinal?: boolean;
  /** Maximum number of gaps kept in the report. Defaults to 25. */
  maxGaps?: number;
}

function isValidCandle(candle: Candle): boolean {
  const values = [candle.open, candle.high, candle.low, candle.close];

  if (!values.every(Number.isFinite)) return false;
  if (values.some((value) => value <= 0)) return false;
  if (!Number.isFinite(candle.volume) || candle.volume < 0) return false;
  if (candle.high < candle.low) return false;
  if (candle.high < Math.max(candle.open, candle.close)) return false;
  if (candle.low > Math.min(candle.open, candle.close)) return false;

  return true;
}

/**
 * Pure validation over an array of candles. The same function is used for a
 * freshly fetched page and for data already stored in DuckDB.
 */
export function validateCandles(
  candles: Candle[],
  timeframeMs: number,
  options: ValidateCandleOptions = {},
): CandleValidationReport {
  const requireFinal = options.requireFinal ?? true;
  const maxGaps = options.maxGaps ?? 25;

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const seen = new Set<number>();
  const gaps: CandleGap[] = [];

  let invalid = 0;
  let duplicates = 0;
  let misaligned = 0;
  let nonFinalCandles = 0;
  let missingIntervals = 0;
  let previousOpenTime: number | null = null;

  for (const candle of sorted) {
    if (!isValidCandle(candle)) invalid++;
    if (!candle.isFinal) nonFinalCandles++;

    if (seen.has(candle.openTime)) {
      duplicates++;
      continue;
    }
    seen.add(candle.openTime);

    if (timeframeMs <= 86_400_000 && candle.openTime % timeframeMs !== 0) {
      misaligned++;
    }

    if (previousOpenTime !== null) {
      const delta = candle.openTime - previousOpenTime;

      if (delta !== timeframeMs) {
        const missing = Math.max(1, Math.round(delta / timeframeMs) - 1);
        missingIntervals += missing;

        if (gaps.length < maxGaps) {
          gaps.push({
            fromOpenTime: previousOpenTime,
            toOpenTime: candle.openTime,
            missing,
          });
        }
      }
    }

    previousOpenTime = candle.openTime;
  }

  const firstOpenTime = sorted[0]?.openTime ?? null;
  const lastOpenTime = sorted.at(-1)?.openTime ?? null;

  return {
    symbol: sorted[0]?.symbol ?? "unknown",
    timeframe: sorted[0]?.timeframe ?? "unknown",
    timeframeMs,
    total: sorted.length,
    finalCandles: sorted.length - nonFinalCandles,
    nonFinalCandles,
    invalid,
    duplicates,
    misaligned,
    firstOpenTime,
    lastOpenTime,
    missingIntervals,
    gaps,
    gapsTruncated: gaps.length >= maxGaps,
    passed:
      invalid === 0 &&
      duplicates === 0 &&
      misaligned === 0 &&
      missingIntervals === 0 &&
      (!requireFinal || nonFinalCandles === 0),
  };
}

export function formatTimestamp(value: number | null): string {
  return value === null ? "n/a" : new Date(value).toISOString();
}

export function formatValidationReport(report: CandleValidationReport): string {
  const lines = [
    `  Symbol:            ${report.symbol}`,
    `  Timeframe:         ${report.timeframe}`,
    `  Candles:           ${report.total}`,
    `  Range:             ${formatTimestamp(report.firstOpenTime)} -> ${formatTimestamp(report.lastOpenTime)}`,
    `  Final candles:     ${report.finalCandles}`,
    `  Non-final:         ${report.nonFinalCandles}`,
    `  Invalid:           ${report.invalid}`,
    `  Duplicates:        ${report.duplicates}`,
    `  Misaligned:        ${report.misaligned}`,
    `  Missing intervals: ${report.missingIntervals}`,
  ];

  if (report.gaps.length > 0) {
    lines.push("  Gaps:");
    for (const gap of report.gaps) {
      lines.push(
        `    ${formatTimestamp(gap.fromOpenTime)} -> ${formatTimestamp(gap.toOpenTime)} (${gap.missing} missing)`,
      );
    }
    if (report.gapsTruncated) lines.push("    ... more gaps omitted");
  }

  lines.push(`  Validation:        ${report.passed ? "PASSED" : "FAILED"}`);

  return lines.join("\n");
}
