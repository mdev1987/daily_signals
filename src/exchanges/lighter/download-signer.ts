import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadLighterConfig } from "./lighter.config";

/**
 * CCXT keeps the signer binaries it is tested against in its repository. The
 * separate `ccxt/lighter-wasm` mirror lags behind: its binary predates the
 * 48-bit market indexes that Lighter testnet uses (4095+), so signing a
 * testnet order fails with "MarketIndex is not valid". Always take the
 * binaries from the CCXT tree that matches the installed CCXT version.
 */
const CCXT_BINARIES =
  "https://raw.githubusercontent.com/ccxt/ccxt/master/ts/src/test/static/binaries";

const SIGNER_FILES = [
  {
    label: "lighter.wasm",
    url: `${CCXT_BINARIES}/lighter-signer.wasm`,
    env: "LIGHTER_LIBRARY_PATH",
    minBytes: 1_000_000,
  },
  {
    label: "wasm_exec.js",
    url: `${CCXT_BINARIES}/wasm_exec.js`,
    env: "LIGHTER_WASM_EXEC_PATH",
    minBytes: 1_000,
  },
] as const;

/**
 * Downloads the CCXT signing runtime used by Lighter's private API. The binary
 * is large and belongs to CCXT, so it lives in the gitignored cache instead of
 * the repository. No credentials are read or written.
 *
 * Run with: bun run lighter:setup
 */
async function main(): Promise<void> {
  const config = loadLighterConfig();
  const force = process.env.LIGHTER_SIGNER_FORCE === "1";
  const targets = [
    { ...SIGNER_FILES[0], path: config.libraryPath },
    { ...SIGNER_FILES[1], path: config.wasmExecPath },
  ];

  console.log("=== LIGHTER SIGNER SETUP ===");

  for (const target of targets) {
    if (!force) {
      const existing = await stat(target.path).catch(() => null);
      if (existing?.isFile() && existing.size >= target.minBytes) {
        console.log(
          `  ${target.label}: present (${existing.size} bytes) -> ${target.path}`,
        );
        continue;
      }
      if (existing?.isFile()) {
        console.log(
          `  ${target.label}: cached file is too small (${existing.size} bytes), re-downloading`,
        );
      }
    }

    console.log(`  ${target.label}: downloading from ${target.url}`);
    const response = await fetch(target.url);

    if (!response.ok) {
      throw new Error(
        `${target.label} download failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < target.minBytes) {
      throw new Error(
        `${target.label} download is truncated: ${bytes.byteLength} bytes ` +
          `(expected at least ${target.minBytes})`,
      );
    }

    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, bytes);
    console.log(
      `  ${target.label}: saved ${bytes.byteLength} bytes -> ${target.path}`,
    );
  }

  console.log("");
  console.log("Signer ready. Set LIGHTER_LIBRARY_PATH / LIGHTER_WASM_EXEC_PATH");
  console.log("to override these paths, then run `bun run lighter:account`.");
}

if (import.meta.main) {
  await main();
}
