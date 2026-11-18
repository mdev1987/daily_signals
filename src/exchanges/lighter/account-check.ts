import { LighterAdapter } from "./lighter.adapter";
import { describeLighterConfig, loadLighterConfig } from "./lighter.config";

/**
 * Read-only Lighter account check.
 *
 * Signs in with the API key, then reads balance, positions and open orders. It
 * never places or cancels anything and never prints the key. Run with:
 *   bun run lighter:account
 */
async function main(): Promise<void> {
  const config = loadLighterConfig();

  console.log("=== LIGHTER ACCOUNT CHECK (READ ONLY) ===");
  console.log(JSON.stringify(describeLighterConfig(config), null, 2));

  if (!config.privateApiEnabled) {
    console.log("");
    console.log(
      "Skipped: LIGHTER_PRIVATE_API_ENABLED is false. Set it to true to read",
    );
    console.log("the account. Order submission stays blocked regardless.");
    return;
  }

  const adapter = new LighterAdapter({ config });

  try {
    await adapter.connect();

    const auth = adapter.getAuthInfo();
    console.log("");
    console.log(`Account index:   ${auth.accountIndex ?? "n/a"}`);
    console.log(`API key index:   ${auth.apiKeyIndex ?? "n/a"}`);
    console.log(`Chain id:        ${auth.chainId}`);
    console.log(`Private base:    ${auth.baseUrl}`);

    // Sequential on purpose: the first call loads the wasm signer and mints the
    // auth token that the following calls reuse.
    const balances = await adapter.getBalance();
    const positions = await adapter.getPositions();
    const openOrders = await adapter.getOpenOrders();

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
  } catch (error) {
    console.error("");
    console.error(`ACCOUNT CHECK FAILED: ${adapter.redact(error)}`);
    console.error("");
    console.error("Check:");
    console.error(
      "  - LIGHTER_KEY_INDEX must be a key registered on LIGHTER_ACCOUNT_INDEX",
    );
    console.error(
      "    (web UI -> Settings -> API Keys; index 0-3 is reserved, 4-254 for automation)",
    );
    console.error(
      "  - The key must belong to the same environment as LIGHTER_PRIVATE_API_ENV",
    );
    console.error(
      "  - Run `bun run lighter:setup` if the wasm signer is missing",
    );
    process.exitCode = 1;
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
