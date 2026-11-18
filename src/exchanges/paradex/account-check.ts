import { createExchangeAdapter } from "../exchange.factory";
import { ParadexAdapter } from "./paradex.adapter";
import { describeParadexConfig, loadParadexConfig } from "./paradex.config";

/**
 * Read-only Paradex account check.
 *
 * Mints a JWT, then reads balance, positions and open orders. It never places
 * or cancels anything and never prints keys. Run with:
 *   bun run paradex:account
 */
async function main(): Promise<void> {
  const config = loadParadexConfig();

  console.log("=== PARADEX ACCOUNT CHECK (READ ONLY) ===");
  console.log(JSON.stringify(describeParadexConfig(config), null, 2));

  if (!config.privateApiEnabled) {
    console.log("");
    console.log(
      "Skipped: PARADEX_PRIVATE_API_ENABLED is false. Set it to true to read",
    );
    console.log("the account. Order submission stays blocked regardless.");
    return;
  }

  const adapter = createExchangeAdapter({ exchange: "paradex" });

  try {
    await adapter.connect();

    const [balances, positions, openOrders] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
      adapter.getOpenOrders(),
    ]);

    const auth =
      adapter instanceof ParadexAdapter ? adapter.getAuthInfo() : null;
    console.log("");
    console.log(`Auth endpoint:   ${auth?.endpoint ?? "n/a"}`);
    console.log(
      `Token expires:   ${auth ? new Date(auth.expiresAtMs).toISOString() : "n/a"}`,
    );

    console.log(`Balances:        ${balances.length}`);
    for (const balance of balances) {
      console.log(
        `  ${balance.currency} total=${balance.total} free=${balance.free} used=${balance.used}`,
      );
    }

    console.log(`Positions:       ${positions.length}`);
    for (const position of positions) {
      console.log(
        `  ${position.symbol} ${position.side} size=${position.contracts} entry=${position.entryPrice} uPnl=${position.unrealizedPnl}`,
      );
    }

    console.log(`Open orders:     ${openOrders.length}`);
    for (const order of openOrders) {
      console.log(
        `  ${order.symbol} ${order.side} ${order.type} amount=${order.amount} price=${order.price ?? "market"}`,
      );
    }

    console.log("");
    console.log("ACCOUNT CHECK PASSED (no orders submitted)");
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
