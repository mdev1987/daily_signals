import { readFile, writeFile } from "node:fs/promises";

const BASE_URL = "https://biquote.io";
const MAX_AGE_SECONDS = 300;

// Read mapping CSV
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

const csv = await readFile("data/biquote-mapping.csv", "utf8");
const lines = csv.trim().split(/\r?\n/);
const headers = parseCsvLine(lines[0]!);

const matchedIndex = headers.indexOf("matched");
const statusIndex = headers.indexOf("status");

if (matchedIndex < 0 || statusIndex < 0) {
  throw new Error("Invalid mapping CSV headers");
}

const symbols = [
  ...new Set(
    lines
      .slice(1)
      .map(parseCsvLine)
      .filter((row) => row[statusIndex] === "ACTIVE")
      .map((row) => row[matchedIndex])
      .filter((symbol): symbol is string => Boolean(symbol)),
  ),
];

console.log(`Testing ${symbols.length} unique active symbols...`);

if (symbols.length > 100) {
  throw new Error("Biquote batch limit exceeded");
}

// One batch request
const url = new URL("/api/latest", BASE_URL);

for (const symbol of symbols) {
  url.searchParams.append("symbols", symbol);
}

const response = await fetch(url);

if (!response.ok) {
  throw new Error(
    `Biquote API error: ${response.status} ${await response.text()}`,
  );
}

const data: any = await response.json();

// Support array or object responses
const ticks: any[] = Array.isArray(data)
  ? data
  : Object.values(data).filter((item: any) => item && typeof item === "object");

const tickMap = new Map<string, any>();

for (const tick of ticks) {
  if (tick.symbol) {
    tickMap.set(tick.symbol.toUpperCase(), tick);
  }
}

const results = symbols.map((symbol) => {
  const tick = tickMap.get(symbol.toUpperCase());

  if (!tick) {
    return {
      symbol,
      status: "NO_QUOTE",
      price: "",
      bid: "",
      ask: "",
      spread: "",
      marketState: "",
      ageSeconds: "",
      timestamp: "",
      source: "",
    };
  }

  const bid = Number(tick.bid) || 0;
  const ask = Number(tick.ask) || 0;
  const mid = Number(tick.mid) || 0;
  const last = Number(tick.last) || 0;

  const price =
    mid > 0 ? mid : bid > 0 && ask > 0 ? (bid + ask) / 2 : last > 0 ? last : 0;

  const age = Number(tick.quoteAgeSeconds);
  const marketState = tick.marketState ?? "unknown";

  let status = "FRESH";

  if (price <= 0) {
    status = "INVALID_PRICE";
  } else if (marketState.toLowerCase() === "closed") {
    status = "CLOSED";
  } else if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) {
    status = "STALE";
  }

  return {
    symbol,
    status,
    price,
    bid,
    ask,
    spread: tick.spread ?? "",
    marketState,
    ageSeconds: Number.isFinite(age) ? age : "",
    timestamp: tick.timestamp ?? "",
    source: tick.source ?? "",
  };
});

// Save CSV report
const columns = Object.keys(results[0] ?? {});

const escapeCsv = (value: unknown) =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;

const output = [
  columns.join(","),
  ...results.map((row) =>
    columns.map((key) => escapeCsv(row[key as keyof typeof row])).join(","),
  ),
].join("\n");

await writeFile("data/biquote-live-test.csv", output);
await writeFile(
  "data/biquote-live-test.json",
  JSON.stringify(results, null, 2),
);

// Summary
const count = (status: string) =>
  results.filter((row) => row.status === status).length;

console.log("\n========== LIVE QUOTE TEST ==========");
console.log("Requested:    ", symbols.length);
console.log("Received:     ", results.length - count("NO_QUOTE"));
console.log("Fresh:        ", count("FRESH"));
console.log("Closed:       ", count("CLOSED"));
console.log("Stale:        ", count("STALE"));
console.log("Invalid:      ", count("INVALID_PRICE"));
console.log("No quote:     ", count("NO_QUOTE"));
console.log("=====================================");

console.log("\nNon-fresh symbols:");

for (const row of results.filter((x) => x.status !== "FRESH")) {
  console.log(
    `${row.symbol.padEnd(15)} ${row.status.padEnd(15)} age=${row.ageSeconds}`,
  );
}

console.log("\nReports:");
console.log("data/biquote-live-test.csv");
console.log("data/biquote-live-test.json");
