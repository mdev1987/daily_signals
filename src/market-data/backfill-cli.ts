import { parseArgs } from "node:util";
import { createExchangeAdapter } from "../exchanges/exchange.factory";
import {
  resolveExchangeProfile,
  type ExchangeProfile,
} from "../exchanges/exchange.profile";
import { splitSymbolList } from "../exchanges/market-universe";
import { openResearchDatabase } from "../storage/database";
import { countCandles } from "../storage/repositories/candle.repository";
import {
  backfillUniverse,
  validateStoredSeries,
  type BackfillResult,
} from "./historical-backfill";
import {
  formatMarketReport,
  syncMarketMetadata,
} from "./market-metadata";
import { formatTimestamp } from "./data-validator";
import { timeframeToMs } from "./timeframes";

interface CliOptions {
  profile: ExchangeProfile;
  symbols: string[];
  timeframe: string;
  days: number;
  from?: number;
  to?: number;
  resume: boolean;
  pageLimit: number;
  delayMs: number;
  validate: boolean;
}

function envValue(
  profile: ExchangeProfile,
  key: keyof ExchangeProfile["env"],
): string | undefined {
  return process.env[profile.env[key]];
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      exchange: { type: "string" },
      symbols: { type: "string" },
      timeframe: { type: "string" },
      days: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "no-resume": { type: "boolean" },
      "page-limit": { type: "string" },
      delay: { type: "string" },
      "no-validate": { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });

  const profile = resolveExchangeProfile(values.exchange);

  const timeframe =
    values.timeframe ?? envValue(profile, "timeframe") ?? "5m";
  timeframeToMs(timeframe);

  const days = Number(
    values.days ?? envValue(profile, "backfillDays") ?? 30,
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive number");
  }

  return {
    profile,
    symbols: splitSymbolList(
      values.symbols ?? envValue(profile, "symbols"),
    ),
    timeframe,
    days,
    from: values.from ? Date.parse(values.from) : undefined,
    to: values.to ? Date.parse(values.to) : undefined,
    resume: !values["no-resume"],
    pageLimit: Number(values["page-limit"] ?? 200),
    delayMs: Number(
      values.delay ?? envValue(profile, "requestDelayMs") ?? 250,
    ),
    validate: !values["no-validate"],
  };
}

function formatBackfillResult(result: BackfillResult): string {
  return (
    `  ${result.symbol} ${result.timeframe}: ` +
    `${result.inserted} new / ${result.updated} updated / ` +
    `${result.requests} requests / ${result.stopReason}` +
    (result.resumedFrom === null
      ? ""
      : ` / resumed from ${formatTimestamp(result.resumedFrom)}`)
  );
}

async function main(): Promise<void> {
  const cli = parseCliOptions();
  const { profile } = cli;
  const adapter = createExchangeAdapter({ exchange: profile.id });
  const connection = await openResearchDatabase();

  await adapter.connect();

  try {
    const marketSync = await syncMarketMetadata(adapter, connection, {
      profile,
    });
    console.log(formatMarketReport(marketSync));
    console.log("");

    const requested =
      cli.symbols.length > 0 ? cli.symbols : marketSync.universe.map((m) => m.symbol);
    const markets = profile.selectUniverse(
      marketSync.markets,
      requested,
      requested.length,
    );

    if (markets.length === 0) {
      throw new Error("No eligible markets selected for backfill");
    }

    const to = cli.to ?? Date.now();
    const from = cli.from ?? to - cli.days * 86_400_000;
    const symbols = markets.map((market) => market.symbol);

    console.log("=== BACKFILL ===");
    console.log(`  Exchange:   ${profile.label} (${profile.id})`);
    console.log(`  Symbols:    ${symbols.join(", ")}`);
    console.log(`  Timeframe:  ${cli.timeframe}`);
    console.log(`  Range:      ${formatTimestamp(from)} -> ${formatTimestamp(to)}`);
    console.log(`  Pagination: ${profile.pagination}`);
    console.log(`  Resume:     ${cli.resume}`);
    console.log("");

    const { results, failures } = await backfillUniverse(adapter, connection, {
      symbols,
      timeframe: cli.timeframe,
      from,
      to,
      resume: cli.resume,
      pageLimit: cli.pageLimit,
      requestDelayMs: cli.delayMs,
      pagination: profile.pagination,
    });

    for (const result of results) {
      console.log(formatBackfillResult(result));
    }
    for (const failure of failures) {
      console.error(`  FAILED ${failure}`);
    }

    console.log("");
    console.log("=== DATA QUALITY ===");
    if (profile.sparseCandles) {
      console.log(
        "  Note: this venue omits intervals without trades; gaps are reported " +
          "but do not fail the series.",
      );
    }

    let allPassed = failures.length === 0;

    if (cli.validate) {
      for (const result of results) {
        const summary = await validateStoredSeries(
          connection,
          result.exchange,
          result.symbol,
          result.timeframe,
          { allowSparse: profile.sparseCandles },
        );

        allPassed &&= summary.passed;

        console.log(
          `  ${summary.symbol} ${summary.timeframe}: ${summary.candles} candles | ` +
            `invalid=${summary.invalid} duplicates=${summary.duplicates} ` +
            `gaps=${summary.missingIntervals} non-final=${summary.nonFinalCandles} | ` +
            `${formatTimestamp(summary.firstOpenTime)} -> ${formatTimestamp(summary.lastOpenTime)} | ` +
            `${summary.passed ? "PASSED" : "FAILED"}`,
        );
      }
    } else {
      for (const result of results) {
        const total = await countCandles(
          connection,
          result.exchange,
          result.symbol,
          result.timeframe,
        );
        console.log(`  ${result.symbol} ${result.timeframe}: ${total} candles (validation skipped)`);
      }
    }

    console.log("");
    console.log("=== EXECUTION SAFETY ===");
    const summary = profile.describe();
    console.log(`  Mode:                 ${summary.tradingMode}`);
    console.log(`  Live orders enabled:  ${summary.liveTradingEnabled}`);
    console.log(`  Order submission:     ${summary.orderSubmissionEnabled}`);
    console.log(`  Validation:           ${allPassed ? "PASSED" : "FAILED"}`);

    if (!allPassed) process.exitCode = 1;
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
