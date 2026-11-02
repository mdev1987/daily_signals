import finnhub from "finnhub";
import { FINNHUB_API_KEY } from "./config";

const client = new finnhub.DefaultApi(FINNHUB_API_KEY);

export interface Quote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Change percent
  h: number; // High
  l: number; // Low
  o: number; // Open
  pc: number; // Previous close
  t: number; // Timestamp
}

export function getQuote(symbol: string): Promise<Quote> {
  return new Promise((resolve, reject) => {
    client.quote(symbol, (error: unknown, data: Quote) => {
      if (error) {
        reject(error);
        return;
      }

      if (!data || data.c <= 0) {
        reject(new Error(`No valid quote for ${symbol}`));
        return;
      }

      resolve(data);
    });
  });
}
