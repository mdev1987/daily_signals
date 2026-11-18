import { createExchangeAdapter } from "../exchange.factory";
import { isEligibleApexPerpetual } from "./apex.market-mapper";
import { describeApexConfig, loadApexConfig } from "./apex.config";

function formatPair(price: number | null): string {
  return price === null ? "n/a" : price.toString();
}

/**
 * Phase 1 smoke test: public market data only.
 *
 * No credentials are used and no order is submitted. Run with:
 *   bun run src/exchanges/apex/smoke-test.ts
 */
async function main(): Promise<void> {
  const config = loadApexConfig();
  const adapter = createExchangeAdapter({ exchange: "apex" });
  const startedAt = Date.now();

  console.log("=== APEX SMOKE TEST (PUBLIC) ===");
  console.log(JSON.stringify(describeApexConfig(config), null, 2));

  await adapter.connect();

  try {
    const markets = await adapter.getMarkets();
    const eligible = markets.filter(isEligibleApexPerpetual);
    const serverTime = await adapter.getServerTime();

    console.log(`Markets loaded:      ${markets.length}`);
    console.log(`Eligible perpetuals: ${eligible.length}`);
    console.log(`Server time:         ${new Date(serverTime).toISOString()}`);
    console.log(`Clock offset:        ${serverTime - Date.now()} ms`);

    if (eligible.length === 0) {
      throw new Error("No active linear USDT perpetual markets found");
    }

    const symbol =
      process.env.APEX_SMOKE_SYMBOL ??
      eligible.find((market) => market.base === "BTC")?.symbol ??
      eligible[0]!.symbol;

    console.log(`Selected market:     ${symbol}`);

    const ticker = await adapter.getTicker(symbol);
    console.log(
      `Ticker:              last=${formatPair(ticker.last)} bid=${formatPair(ticker.bid)} ask=${formatPair(ticker.ask)}`,
    );

    const book = await adapter.getOrderBook(symbol, 5);
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    console.log(
      `Order book:          bids=${book.bids.length} asks=${book.asks.length} ` +
        `bestBid=${bestBid ? bestBid.price : "n/a"} bestAsk=${bestAsk ? bestAsk.price : "n/a"}`,
    );

    const trades = await adapter.getTrades(symbol, undefined, 5);
    console.log(`Recent trades:       ${trades.length}`);
    for (const trade of trades) {
      console.log(
        `  ${new Date(trade.timestamp ?? 0).toISOString()} ${trade.side ?? "?"} ${trade.amount} @ ${trade.price}`,
      );
    }

    const candles = await adapter.getOHLCV(symbol, "5m", undefined, 10);
    console.log(`5m candles:          ${candles.length}`);
    for (const candle of candles) {
      console.log(
        `  ${new Date(candle.openTime).toISOString()} O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume} final=${candle.isFinal}`,
      );
    }

    if (candles.length === 0) {
      throw new Error("No 5m candles returned");
    }

    console.log("");
    console.log("SMOKE TEST PASSED (no orders submitted)");
    console.log(`Duration:            ${Date.now() - startedAt} ms`);
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
