import { createExchangeAdapter } from "../exchange.factory";
import { isEligibleLighterPerpetual } from "./lighter.market-mapper";
import { describeLighterConfig, loadLighterConfig } from "./lighter.config";

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toString();
}

/**
 * Lighter smoke test: public market data only.
 *
 * No credentials are used and no order is submitted. Run with:
 *   bun run lighter:smoke
 */
async function main(): Promise<void> {
  const config = loadLighterConfig();
  const adapter = createExchangeAdapter({ exchange: "lighter" });
  const startedAt = Date.now();

  console.log("=== LIGHTER SMOKE TEST (PUBLIC) ===");
  console.log(JSON.stringify(describeLighterConfig(config), null, 2));

  await adapter.connect();

  try {
    const markets = await adapter.getMarkets();
    const eligible = markets.filter(isEligibleLighterPerpetual);
    const serverTime = await adapter.getServerTime();

    console.log(`Markets loaded:      ${markets.length}`);
    console.log(`Eligible perpetuals: ${eligible.length}`);
    console.log(
      `Base URL:            ${config.baseUrls[config.marketDataEnvironment]}`,
    );
    console.log(`Server time:         ${new Date(serverTime).toISOString()}`);
    console.log(`Clock offset:        ${serverTime - Date.now()} ms`);

    if (eligible.length === 0) {
      throw new Error("No active linear USDC perpetual markets found");
    }

    const symbol =
      process.env.LIGHTER_SMOKE_SYMBOL ??
      eligible.find((market) => market.base === "BTC")?.symbol ??
      eligible[0]!.symbol;

    console.log(`Selected market:     ${symbol}`);

    const ticker = await adapter.getTicker(symbol);
    console.log(
      `Ticker:              last=${formatNumber(ticker.last)} bid=${formatNumber(ticker.bid)} ask=${formatNumber(ticker.ask)}`,
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

    const candles = await adapter.getOHLCV(symbol, "5m", undefined, 200);
    console.log(`5m candles:          ${candles.length}`);
    for (const candle of candles.slice(-5)) {
      console.log(
        `  ${new Date(candle.openTime).toISOString()} O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume} final=${candle.isFinal}`,
      );
    }

    if (candles.length === 0) {
      throw new Error("No 5m candles returned");
    }

    const funding = await adapter.getFundingRates(symbol, undefined, 3);
    console.log(`Funding rates:       ${funding.length}`);
    for (const rate of funding) {
      console.log(
        `  ${new Date(rate.timestamp ?? 0).toISOString()} ${rate.rate}`,
      );
    }

    console.log("");
    console.log("SMOKE TEST PASSED (no credentials used, no orders submitted)");
    console.log(`Duration:            ${Date.now() - startedAt} ms`);
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
