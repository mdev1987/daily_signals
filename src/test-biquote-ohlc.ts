import { mkdir } from "node:fs/promises";

const BASE_URL = "https://biquote.io/api";
const MAPPING_FILE = "data/biquote-mapping.csv";
const OUTPUT_DIR = "data";

const INTERVALS = ["5m", "15m", "30m", "1h", "4h", "1d"];
const LIMIT = 100;
const CONCURRENCY = 5;

type Mapping = {
  input: string;
  symbol: string;
  status: string;
};

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
  input: string;
  symbol: string;
  interval: string;
  requested: number;
  received: number;
  closed: number;
  open: number;
  valid: number;
  invalid: number;
  duplicateTimes: number;
  chronological: boolean;
  oldest: string | null;
  newest: string | null;
  status: string;
  error: string | null;
};

// Minimal CSV parser supporting quoted fields and escaped quotes.
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      result.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  result.push(value);
  return result;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);

  for (const candidate of candidates) {
    const index = normalized.indexOf(normalizeHeader(candidate));
    if (index !== -1) return index;
  }

  return -1;
}

async function loadMappings(): Promise<Mapping[]> {
  const content = await Bun.file(MAPPING_FILE).text();
  const lines = content.trim().split(/\r?\n/);

  if (lines.length < 2) {
    throw new Error(`No mapping rows found in ${MAPPING_FILE}`);
  }

  const headers = parseCsvLine(lines[0]!);

  const inputIndex = findColumn(headers, [
    "input",
    "original",
    "originalSymbol",
    "inputSymbol",
    "name",
  ]);

  const symbolIndex = findColumn(headers, [
    "matched",
    "biquoteSymbol",
    "biquote",
    "matchedSymbol",
  ]);

  const statusIndex = findColumn(headers, ["status"]);

  if (symbolIndex === -1) {
    throw new Error(
      `Could not find mapped symbol column. CSV headers: ${headers.join(", ")}`,
    );
  }

  const mappings: Mapping[] = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;

    const columns = parseCsvLine(line);
    const symbol = columns[symbolIndex]?.trim();
    const status =
      statusIndex >= 0 ? columns[statusIndex]?.trim().toUpperCase() : "ACTIVE";

    if (!symbol) continue;
    if (status !== "ACTIVE") continue;

    mappings.push({
      input: inputIndex >= 0 ? columns[inputIndex]?.trim() || symbol : symbol,
      symbol,
      status,
    });
  }

  // Test each underlying Biquote instrument only once.
  const unique = new Map<string, Mapping>();

  for (const mapping of mappings) {
    unique.set(mapping.symbol.toUpperCase(), mapping);
  }

  return [...unique.values()];
}

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

async function testOhlc(mapping: Mapping, interval: string): Promise<Report> {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(mapping.symbol)}/ohlc`);

  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(LIMIT));

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as OhlcResponse;

    if (!Array.isArray(data.bars)) {
      throw new Error("Invalid API response: bars is not an array");
    }

    const bars = data.bars;
    const closedBars = bars.filter((bar) => !bar.isOpen);
    const openBars = bars.filter((bar) => bar.isOpen);

    const valid = bars.filter(validateBar);
    const invalid = bars.length - valid.length;

    const timestamps = bars.map((bar) => Date.parse(bar.openTime));
    const uniqueTimestamps = new Set(timestamps);

    // API is expected to return newest candles first.
    let chronological = true;

    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i]! >= timestamps[i - 1]!) {
        chronological = false;
        break;
      }
    }

    const sortedTimes = timestamps
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    return {
      input: mapping.input,
      symbol: mapping.symbol,
      interval,
      requested: LIMIT,
      received: bars.length,
      closed: closedBars.length,
      open: openBars.length,
      valid: valid.length,
      invalid,
      duplicateTimes: timestamps.length - uniqueTimestamps.size,
      chronological,
      oldest: sortedTimes.length
        ? new Date(sortedTimes[0]!).toISOString()
        : null,
      newest: sortedTimes.length
        ? new Date(sortedTimes[sortedTimes.length - 1]!).toISOString()
        : null,
      status: bars.length === 0 ? "NO_DATA" : "OK",
      error: null,
    };
  } catch (error) {
    return {
      input: mapping.input,
      symbol: mapping.symbol,
      interval,
      requested: LIMIT,
      received: 0,
      closed: 0,
      open: 0,
      valid: 0,
      invalid: 0,
      duplicateTimes: 0,
      chronological: false,
      oldest: null,
      newest: null,
      status: "ERROR",
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

  const mappings = await loadMappings();

  console.log(`Biquote OHLC Coverage Test`);
  console.log(`Symbols: ${mappings.length}`);
  console.log(`Intervals: ${INTERVALS.join(", ")}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("--------------------------------");

  const jobs = mappings.flatMap((mapping) =>
    INTERVALS.map((interval) => ({ mapping, interval })),
  );

  console.log(`Total requests: ${jobs.length}`);
  console.log("Testing...\n");

  let completed = 0;

  const reports = await runWithConcurrency(
    jobs,
    CONCURRENCY,
    async ({ mapping, interval }) => {
      const report = await testOhlc(mapping, interval);

      completed++;

      if (
        report.status !== "OK" ||
        report.invalid > 0 ||
        !report.chronological
      ) {
        console.log(
          `[${completed}/${jobs.length}] ${report.symbol} ${interval}: ${report.status}` +
            (report.error ? ` - ${report.error}` : ""),
        );
      } else if (completed % 25 === 0 || completed === jobs.length) {
        console.log(`[${completed}/${jobs.length}] completed`);
      }

      return report;
    },
  );

  const headers = [
    "input",
    "symbol",
    "interval",
    "requested",
    "received",
    "closed",
    "open",
    "valid",
    "invalid",
    "duplicateTimes",
    "chronological",
    "oldest",
    "newest",
    "status",
    "error",
  ];

  const csv = [
    headers.join(","),
    ...reports.map((report) =>
      headers
        .map((header) => escapeCsv(report[header as keyof Report]))
        .join(","),
    ),
  ].join("\n");

  await Bun.write(`${OUTPUT_DIR}/biquote-ohlc-coverage.csv`, csv);

  await Bun.write(
    `${OUTPUT_DIR}/biquote-ohlc-coverage.json`,
    JSON.stringify(reports, null, 2),
  );

  const total = reports.length;
  const successful = reports.filter((r) => r.status === "OK");
  const failed = reports.filter((r) => r.status === "ERROR");
  const noData = reports.filter((r) => r.status === "NO_DATA");

  const totalReceived = reports.reduce((sum, r) => sum + r.received, 0);
  const totalClosed = reports.reduce((sum, r) => sum + r.closed, 0);
  const totalOpen = reports.reduce((sum, r) => sum + r.open, 0);
  const totalInvalid = reports.reduce((sum, r) => sum + r.invalid, 0);

  console.log("\n========== OHLC SUMMARY ==========");
  console.log(`Requests:       ${total}`);
  console.log(`Successful:     ${successful.length}`);
  console.log(`No data:        ${noData.length}`);
  console.log(`Errors:         ${failed.length}`);
  console.log(`Candles:        ${totalReceived}`);
  console.log(`Closed:         ${totalClosed}`);
  console.log(`Open:           ${totalOpen}`);
  console.log(`Invalid:        ${totalInvalid}`);
  console.log("==================================");

  console.log("\nInterval coverage:");

  for (const interval of INTERVALS) {
    const rows = reports.filter((r) => r.interval === interval);
    const withData = rows.filter((r) => r.received > 0).length;
    const closed = rows.reduce((sum, r) => sum + r.closed, 0);

    console.log(
      `${interval.padEnd(5)} ${withData}/${rows.length} symbols | ${closed} closed candles`,
    );
  }

  console.log("\nReports:");
  console.log(`- ${OUTPUT_DIR}/biquote-ohlc-coverage.csv`);
  console.log(`- ${OUTPUT_DIR}/biquote-ohlc-coverage.json`);
}

main().catch((error) => {
  console.error("OHLC test failed:", error);
  process.exit(1);
});
