const BASE_URL = "https://biquote.io/api";
const INPUT_FILE = "./data/symbols.csv";
const OUTPUT_FILE = "./data/biquote-coverage.csv";

interface Instrument {
  name?: string;
  symbol?: string;
  description?: string;
  type?: string;
  exchange?: string;
  source?: string;
}

interface CoverageRow {
  original: string;
  matched: string;
  type: string;
  source: string;
  inCatalog: boolean;
  activeNow: boolean;
}

function normalize(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function extractInstruments(data: unknown): Instrument[] {
  if (Array.isArray(data)) {
    return data as Instrument[];
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    for (const key of ["symbols", "items", "data", "results"]) {
      if (Array.isArray(obj[key])) {
        return obj[key] as Instrument[];
      }
    }
  }

  throw new Error("Unexpected Biquote symbols response format");
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`Biquote API error ${response.status}: ${path}`);
  }

  return response.json();
}

function readSymbolsCsv(content: string): string[] {
  return content
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^"|"$/g, ""))
    .filter((symbol) => symbol.toLowerCase() !== "symbol");
}

function csvEscape(value: string | boolean): string {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function main() {
  console.log("Biquote Symbol Coverage Test\n");

  const csv = await Bun.file(INPUT_FILE).text();
  const inputSymbols = readSymbolsCsv(csv);

  console.log(`Input symbols: ${inputSymbols.length}`);

  const [catalogData, activeData] = await Promise.all([
    getJson("/symbols"),
    getJson("/active"),
  ]);

  const catalog = extractInstruments(catalogData);
  const active = extractInstruments(activeData);

  await Bun.write(
    "./data/biquote-symbols.json",
    JSON.stringify(catalog, null, 2),
  );

  await Bun.write(
    "./data/biquote-active.json",
    JSON.stringify(active, null, 2),
  );

  console.log(`Catalog symbols: ${catalog.length}`);
  console.log(`Active symbols: ${active.length}\n`);

  const catalogMap = new Map<string, Instrument>();
  const activeSet = new Set<string>();

  for (const item of catalog) {
    const name = item.name ?? item.symbol;
    if (name) {
      catalogMap.set(normalize(name), item);
    }
  }

  for (const item of active) {
    const name = item.name ?? item.symbol;
    if (name) {
      activeSet.add(normalize(name));
    }
  }

  const results: CoverageRow[] = inputSymbols.map((original) => {
    const key = normalize(original);
    const match = catalogMap.get(key);

    return {
      original,
      matched: match?.name ?? match?.symbol ?? "",
      type: match?.type ?? "",
      source: match?.source ?? "",
      inCatalog: Boolean(match),
      activeNow: activeSet.has(key),
    };
  });

  const found = results.filter((r) => r.inCatalog);
  const activeCount = results.filter((r) => r.activeNow);

  const header = [
    "original",
    "matched",
    "type",
    "source",
    "in_catalog",
    "active_now",
  ];

  const lines = [
    header.join(","),
    ...results.map((r) =>
      [r.original, r.matched, r.type, r.source, r.inCatalog, r.activeNow]
        .map(csvEscape)
        .join(","),
    ),
  ];

  await Bun.write(OUTPUT_FILE, lines.join("\n"));

  console.log("========== COVERAGE ==========");
  console.log(`Total:       ${results.length}`);
  console.log(`In catalog:  ${found.length}`);
  console.log(`Not found:   ${results.length - found.length}`);
  console.log(`Active now:  ${activeCount.length}`);
  console.log("==============================\n");

  console.log("Not found:");

  for (const row of results.filter((r) => !r.inCatalog)) {
    console.log(`  - ${row.original}`);
  }

  console.log(`\nReport saved: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Coverage test failed:", error);
  process.exit(1);
});
