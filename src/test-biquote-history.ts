import { mkdir } from "node:fs/promises";

const BASE_URL = "https://biquote.io/api";
const OUTPUT_DIR = "data";

const SYMBOLS = ["EURUSD", "BTCUSD", "XAUUSD", "GOOGL", "UK100"];
const INTERVALS = ["5m", "1h", "1d"];

const LIMIT = 1000;
const CONCURRENCY = 3;

type Bar = {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickVolume: number;
  isOpen: boolean;
};

type OhlcResponse = {
  symbol: string;
  interval: string;
  bars: Bar[];
};

type Report = {
  symbol: string;
  interval: string;
  requested: number;
  received: number;
  closed: number;
  open: number;
  invalid: number;
  duplicateTimes: number;
  chronological: boolean;
  oldest: string | null;
  newest: string | null;
  historyDays: number;
  gaps: number;
  largestGapMinutes: number;
  largestGapFrom: string | null;
  largestGapTo: string | null;
  status: string;
  error: string | null;
};

const INTERVAL_MINUTES: Record<string, number> = {
  "5m": 5,
  "1h": 60,
  "1d": 1440,
};

function validateBar(bar: Bar): boolean {
  const values = [bar.open, bar.high, bar.low, bar.close];

  if (!values.every(Number.isFinite)) return false;
  if (!bar.openTime || !Number.isFinite(Date.parse(bar.openTime))) {
    return false;
  }

  if (values.some((value) => value <= 0)) return false;
  if (bar.high < bar.low) return false;
  if (bar.high < Math.max(bar.open, bar.close)) return false;
  if (bar.low > Math.min(bar.open, bar.close)) return false;

  return true;
}

async function testHistory(symbol: string, interval: string): Promise<Report> {
  const emptyReport: Report = {
    symbol,
    interval,
    requested: LIMIT,
    received: 0,
    closed: 0,
    open: 0,
    invalid: 0,
    duplicateTimes: 0,
    chronological: false,
    oldest: null,
    newest: null,
    historyDays: 0,
    gaps: 0,
    largestGapMinutes: 0,
    largestGapFrom: null,
    largestGapTo: null,
    status: "ERROR",
    error: null,
  };

  try {
    const url = new URL(`${BASE_URL}/${encodeURIComponent(symbol)}/ohlc`);

    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(LIMIT));

    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as OhlcResponse;

    if (!Array.isArray(data.bars)) {
      throw new Error("Invalid API response: bars is not an array");
    }

    const bars = data.bars;

    const validBars = bars.filter(validateBar);
    const closedBars = bars.filter((bar) => !bar.isOpen);

    const timestamps = bars
      .map((bar) => Date.parse(bar.openTime))
      .filter(Number.isFinite);

    const uniqueTimestamps = new Set(timestamps);

    // API is expected to return newest candles first.
    let chronological = true;

    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i]! >= timestamps[i - 1]!) {
        chronological = false;
        break;
      }
    }

    // Analyze gaps using unique timestamps, oldest to newest.
    const sortedTimes = [...uniqueTimestamps].sort((a, b) => a - b);

    const intervalMinutes = INTERVAL_MINUTES[interval];

    if (intervalMinutes === undefined) {
      throw new Error(`Unsupported interval: ${interval}`);
    }

    const intervalMs = intervalMinutes * 60_000;

    let gaps = 0;
    let largestGapMs = 0;
    let largestGapFrom: number | null = null;
    let largestGapTo: number | null = null;

    for (let i = 1; i < sortedTimes.length; i++) {
      const difference = sortedTimes[i]! - sortedTimes[i - 1]!;

      // Allow a small tolerance for timestamp alignment.
      if (difference > intervalMs * 1.5) {
        gaps++;

        if (difference > largestGapMs) {
          largestGapMs = difference;
          largestGapFrom = sortedTimes[i - 1]!;
          largestGapTo = sortedTimes[i]!;
        }
      }
    }

    const oldest = sortedTimes[0] ?? null;
    const newest = sortedTimes[sortedTimes.length - 1] ?? null;

    const historyDays =
      oldest !== null && newest !== null ? (newest - oldest) / 86_400_000 : 0;

    return {
      ...emptyReport,
      received: bars.length,
      closed: closedBars.length,
      open: bars.filter((bar) => bar.isOpen).length,
      invalid: bars.length - validBars.length,
      duplicateTimes: timestamps.length - uniqueTimestamps.size,
      chronological,
      oldest: oldest !== null ? new Date(oldest).toISOString() : null,
      newest: newest !== null ? new Date(newest).toISOString() : null,
      historyDays: Number(historyDays.toFixed(2)),
      gaps,
      largestGapMinutes: Number((largestGapMs / 60_000).toFixed(2)),
      largestGapFrom:
        largestGapFrom !== null ? new Date(largestGapFrom).toISOString() : null,
      largestGapTo:
        largestGapTo !== null ? new Date(largestGapTo).toISOString() : null,
      status: bars.length === 0 ? "NO_DATA" : "OK",
    };
  } catch (error) {
    return {
      ...emptyReport,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      results[index] = await task(items[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function escapeCsv(value: unknown): string {
  const text = value == null ? "" : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const jobs = SYMBOLS.flatMap((symbol) =>
    INTERVALS.map((interval) => ({ symbol, interval })),
  );

  console.log("Biquote Historical Depth Test");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Intervals: ${INTERVALS.join(", ")}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("--------------------------------");
  console.log(`Total requests: ${jobs.length}\n`);

  let completed = 0;

  const reports = await runWithConcurrency(
    jobs,
    CONCURRENCY,
    async ({ symbol, interval }) => {
      const report = await testHistory(symbol, interval);

      completed++;

      const message =
        `[${completed}/${jobs.length}] ${symbol.padEnd(7)} ${interval.padEnd(3)} ` +
        `${report.received} candles | ${report.historyDays} days | ` +
        `${report.gaps} gaps`;

      console.log(
        report.status === "OK" ? message : `${message} | ${report.error}`,
      );

      return report;
    },
  );

  const headers: (keyof Report)[] = [
    "symbol",
    "interval",
    "requested",
    "received",
    "closed",
    "open",
    "invalid",
    "duplicateTimes",
    "chronological",
    "oldest",
    "newest",
    "historyDays",
    "gaps",
    "largestGapMinutes",
    "largestGapFrom",
    "largestGapTo",
    "status",
    "error",
  ];

  const csv = [
    headers.join(","),
    ...reports.map((report) =>
      headers.map((header) => escapeCsv(report[header])).join(","),
    ),
  ].join("\n");

  await Bun.write(`${OUTPUT_DIR}/biquote-history-test.csv`, csv);

  await Bun.write(
    `${OUTPUT_DIR}/biquote-history-test.json`,
    JSON.stringify(reports, null, 2),
  );

  console.log("\n========== HISTORY SUMMARY ==========");

  for (const interval of INTERVALS) {
    console.log(`\n${interval}:`);

    for (const report of reports.filter((item) => item.interval === interval)) {
      console.log(
        `  ${report.symbol.padEnd(7)} ` +
          `${String(report.closed).padStart(5)} closed | ` +
          `${String(report.historyDays).padStart(8)} days | ` +
          `${String(report.gaps).padStart(4)} gaps | ` +
          `largest: ${report.largestGapMinutes} min`,
      );
    }
  }

  console.log("\n=====================================");
  console.log(`Reports:`);
  console.log(`- ${OUTPUT_DIR}/biquote-history-test.csv`);
  console.log(`- ${OUTPUT_DIR}/biquote-history-test.json`);
}

main().catch((error) => {
  console.error("History test failed:", error);
  process.exit(1);
});
