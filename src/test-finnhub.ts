import finnhub from "finnhub";
import { FINNHUB_API_KEY } from "./config";

const client = new finnhub.DefaultApi(FINNHUB_API_KEY);

const forexSymbols = [
  "OANDA:EUR_USD",
  "OANDA:GBP_USD",
  "OANDA:USD_JPY",
  "OANDA:XAU_USD",
];

const cryptoSymbols = ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"];

function getQuote(symbol: string): Promise<any> {
  return new Promise((resolve, reject) => {
    client.quote(symbol, (error: unknown, data: any) => {
      if (error) return reject(error);
      resolve(data);
    });
  });
}

for (const symbol of [...forexSymbols, ...cryptoSymbols]) {
  try {
    const q = await getQuote(symbol);

    console.log(`${symbol.padEnd(20)} ${q.c > 0 ? q.c : "NO DATA"}`);
  } catch (error) {
    console.error(symbol, error);
  }

  await Bun.sleep(1100);
}
