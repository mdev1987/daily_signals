import { readFile, writeFile } from "node:fs/promises";

type Instrument = {
  name: string;
  description?: string;
  type?: string;
  exchange?: string;
  source?: string;
  isActive?: boolean;
  hasData?: boolean;
};

const symbolsText = await readFile("data/symbols.csv", "utf8");
const catalog: Instrument[] = JSON.parse(
  await readFile("data/biquote-symbols.json", "utf8"),
);
const active: Instrument[] = JSON.parse(
  await readFile("data/biquote-active.json", "utf8"),
);

const symbols = symbolsText
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean);

const normalize = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const aliases: Record<string, string> = {
  "AT&T": "T",
  "Alphabet A": "GOOGL",
  "Alphabet C": "GOOG",
  "Amazon.com": "AMZN",
  Apple: "AAPL",
  "Bank of America": "BAC",
  "Coca-Cola": "KO",
  Facebook: "META",
  FedEx: "FDX",
  "HP Inc": "HPQ",
  IBM: "IBM",
  Mastercard: "MA",
  Micron: "MU",
  Microsoft: "MSFT",
  NVIDIA: "NVDA",
  "PayPal Holdings Inc": "PYPL",
  eBay: "EBAY",
  "Lowe’s": "LOW",
  Gold: "XAUUSD",
  Silver: "XAGUSD",
};

const catalogByName = new Map(
  catalog.map((item) => [normalize(item.name), item]),
);

const activeNames = new Set(active.map((item) => normalize(item.name)));

const tokenize = (value: string) =>
  normalize(value).match(/[A-Z]+|[0-9]+/g) ?? [];

function findCandidates(label: string) {
  const words = new Set(tokenize(label));
  if (!words.size) return [];

  return catalog
    .map((item) => {
      const text = new Set([
        ...tokenize(item.name),
        ...tokenize(item.description ?? ""),
      ]);

      const overlap = [...words].filter((word) => text.has(word)).length;
      return {
        item,
        score: overlap / words.size,
      };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => `${x.item.name} (${Math.round(x.score * 100)}%)`);
}

const results = symbols.map((label) => {
  const alias = aliases[label];
  const exact = catalogByName.get(normalize(label));
  const aliased = alias ? catalogByName.get(normalize(alias)) : undefined;

  const match = exact ?? aliased;
  const matchType = exact ? "EXACT" : aliased ? "ALIAS" : "UNMATCHED";

  const status = match
    ? activeNames.has(normalize(match.name))
      ? "ACTIVE"
      : "CATALOG_ONLY"
    : "NOT_FOUND";

  return {
    original: label,
    matched: match?.name ?? "",
    matchType,
    status,
    type: match?.type ?? "",
    exchange: match?.exchange ?? "",
    source: match?.source ?? "",
    description: match?.description ?? "",
    candidates: match ? "" : findCandidates(label).join(" | "),
  };
});

const csvEscape = (value: unknown) =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;

const headers = Object.keys(results[0] ?? {});

const csv = [
  headers.join(","),
  ...results.map((row) =>
    headers.map((key) => csvEscape(row[key as keyof typeof row])).join(","),
  ),
].join("\n");

await writeFile("data/biquote-mapping.csv", csv);

const summary = {
  total: results.length,
  active: results.filter((x) => x.status === "ACTIVE").length,
  catalogOnly: results.filter((x) => x.status === "CATALOG_ONLY").length,
  notFound: results.filter((x) => x.status === "NOT_FOUND").length,
  exact: results.filter((x) => x.matchType === "EXACT").length,
  alias: results.filter((x) => x.matchType === "ALIAS").length,
  unmatched: results.filter((x) => x.matchType === "UNMATCHED").length,
};

console.log("\nBiquote Mapping Summary");
console.table(summary);

console.log("\nUnmatched symbols:");
for (const item of results.filter((x) => x.status === "NOT_FOUND")) {
  console.log(`${item.original} => ${item.candidates || "No candidates"}`);
}

console.log("\nReport: data/biquote-mapping.csv");
