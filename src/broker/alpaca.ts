import { Alpaca } from "@alpacahq/alpaca-trade-api";
import { APCA_API_KEY_ID, APCA_API_SECRET_KEY } from "../config";

const keyId = APCA_API_KEY_ID;
const secret = APCA_API_SECRET_KEY;

if (!keyId || !secret) {
  throw new Error("Missing Alpaca API credentials");
}

export const alpaca = new Alpaca({
  keyId,
  secret,
  paper: true,
});

export async function checkAccount() {
  const account = await alpaca.trading.account.getAccount();

  console.log("\n========== ALPACA PAPER ACCOUNT ==========");
  console.log("Status:", account.status);
  console.log("Currency:", account.currency);
  console.log("Cash:", account.cash);
  console.log("Portfolio Value:", account.portfolioValue);
  console.log("Buying Power:", account.buyingPower);
  console.log("Trading Blocked:", account.tradingBlocked);
  console.log("==========================================\n");

  return account;
}
