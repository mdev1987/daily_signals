import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadLighterConfig } from "./lighter.config";

const SIGNER_FILES = [
  {
    label: "lighter.wasm",
    url: "https://raw.githubusercontent.com/ccxt/lighter-wasm/main/lighter.wasm",
    env: "LIGHTER_LIBRARY_PATH",
  },
  {
    label: "wasm_exec.js",
    url: "https://raw.githubusercontent.com/ccxt/lighter-wasm/main/wasm_exec.js",
    env: "LIGHTER_WASM_EXEC_PATH",
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
      if (existing?.isFile() && existing.size > 0) {
        console.log(
          `  ${target.label}: present (${existing.size} bytes) -> ${target.path}`,
        );
        continue;
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
    if (bytes.byteLength === 0) {
      throw new Error(`${target.label} download was empty`);
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
