import { LighterAdapter } from "./lighter.adapter";
import { describeLighterConfig, loadLighterConfig, type LighterConfig } from "./lighter.config";

/**
 * Public, signature-free view of the account on the host being used. It
 * separates "the account is gone" (a testnet reset or a deleted account) from
 * "the key index is wrong", which the signed error alone cannot tell apart.
 */
async function describeAccountOnHost(config: LighterConfig): Promise<void> {
  const base = config.baseUrls[config.privateApiEnvironment];
  const accountIndex = config.credentials.accountIndex;
  if (accountIndex === null) return;

  try {
    const accountResponse = await fetch(
      `${base}/api/v1/account?by=index&value=${accountIndex}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const accountBody = (await accountResponse.json()) as {
      code?: number;
      accounts?: Array<{ collateral?: string }>;
    };
    const account = accountBody.accounts?.[0];

    if (!account) {
      console.error(
        `  - Account ${accountIndex} does not exist on ${base} (code ` +
          `${accountBody.code ?? "?"}). Testnet is reset periodically and ` +
          `deleted accounts stay deleted, so the account and its keys must be ` +
          `created again in the web app.`,
      );
      return;
    }

    console.error(
      `  - Account ${accountIndex} exists on ${base} with collateral ` +
        `${account.collateral ?? "?"}; the key index or key pair is wrong.`,
    );

    const keysResponse = await fetch(
      `${base}/api/v1/apikeys?account_index=${accountIndex}&api_key_index=255`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const keysBody = (await keysResponse.json()) as {
      api_keys?: Array<{ api_key_index?: number }>;
    };
    const indexes = (keysBody.api_keys ?? [])
      .map((key) => key.api_key_index)
      .filter((index): index is number => typeof index === "number");

    console.error(
      `  - Registered key indexes on that account: ` +
        `${indexes.length > 0 ? indexes.join(", ") : "none"}`,
    );
  } catch (error) {
    console.error(
      `  - Could not read the public account state: ${String(error)}`,
    );
  }
}

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
    await describeAccountOnHost(config);
    process.exitCode = 1;
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main();
}
