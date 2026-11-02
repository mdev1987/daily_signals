import { openDatabase } from "./database";
import { collectPricesOnce } from "./price-collector";
import { PRICE_INTERVALS } from "./biquote";

const connection = await openDatabase();

try {
  console.log("Biquote price collection (one pass)");
  console.log(`Intervals: ${PRICE_INTERVALS.join(", ")}`);

  const result = await collectPricesOnce(connection);

  console.log("\n========== PRICE COLLECTION ==========");
  console.log(`Symbols:      ${result.symbols}`);
  console.log(`Requests:     ${result.requests}`);
  console.log(`Succeeded:    ${result.succeeded}`);
  console.log(`Failed:       ${result.failed}`);
  console.log(`Closed bars:  ${result.candles}`);
  console.log(`New rows:     ${result.saved.inserted}`);
  console.log(`Existing:     ${result.saved.unchanged}`);
  console.log(`Duration:     ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("======================================");
} finally {
  connection.disconnectSync();
}
