/**
 * E3 Evaluation CLI
 *
 * Runs the E3 price-confirmation experiment (transition + pip threshold) for
 * all supported timeframes. Read-only: no writes, no persistence.
 *
 * Usage: bun run src/e3-cli.ts <pipThresholdPct>
 */

import { openDatabase } from "./database";
import { evaluateE3 } from "./evaluation";

async function main(): Promise<void> {
  const pipArg = process.argv[2];
  const pipThresholdPct = Number(pipArg ?? "0");
  if (!Number.isFinite(pipThresholdPct) || pipThresholdPct < 0) {
    console.error("Usage: bun run src/e3-cli.ts <pipThresholdPct>");
    process.exit(1);
  }

  const connection = await openDatabase();

  try {
    for (const timeframe of ["5m", "15m", "30m", "1h", "4h", "1d"] as const) {
      const result = await evaluateE3(connection, timeframe, pipThresholdPct);
      console.log(`\n=== E3 tf=${timeframe} pipThresholdPct=${result.pipThresholdPct} ===`);
      for (const signal of Object.keys(result.e3.bySignal).sort()) {
        const entry = result.e3.bySignal[signal]!;
        for (const h of [...Object.keys(entry.horizons)].sort((a, b) => Number(a) - Number(b))) {
          const hs = entry.horizons[h]!;
          if (hs.n > 0) {
            console.log(
              `E3 signal=${signal} horizon=${h} n=${hs.n} meanRet=${hs.meanRet} median=${hs.median} hitRate=${hs.hitRate} mfeMean=${hs.mfeMean} maeMean=${hs.maeMean}`,
            );
          }
        }
      }
    }
  } finally {
    connection.disconnectSync();
  }
}

await main();
