import { afterEach, describe, expect, test } from "bun:test";
import {
  buildParadexAuthTypedData,
  fetchParadexAuthToken,
  readParadexJwtExpiryMs,
  signParadexAuthPayload,
} from "../exchanges/paradex/paradex.auth";
import { loadParadexConfig } from "../exchanges/paradex/paradex.config";
import { ExchangeConfigurationError } from "../exchanges/exchange.errors";

const TEST_ENVIRONMENT = "testnet" as const;
const TEST_CHAIN = "PRIVATE_SN_PARACLEAR_TESTNET";

// Throwaway keypair. Never a real account key.
const TEST_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_ADDRESS = "0x07f0d7d5bcdf0d2f0d0a1b3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7";
const TEST_PUBLIC_KEY =
  "0x04c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeJwt(expSeconds: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: expSeconds })}.sig`;
}

describe("Paradex auth typed data", () => {
  test("signs the /v1/auth path, not the subkey endpoint", () => {
    const typed = buildParadexAuthTypedData(TEST_CHAIN, 1_700_000_000, 1_700_000_300);

    expect(typed.message.path).toBe("/v1/auth");
    expect(typed.message.method).toBe("POST");
    expect(typed.message.body).toBe("");
    expect(typed.message.timestamp).toBe(1_700_000_000);
    expect(typed.message.expiration).toBe(1_700_000_300);
  });

  test("encodes the venue chain id as a short string felt", () => {
    const typed = buildParadexAuthTypedData(TEST_CHAIN, 1, 2);

    expect(typed.domain.name).toBe("Paradex");
    expect(typed.domain.version).toBe("1");
    expect(typed.domain.chainId).toBe(
      "0x505249564154455f534e5f50415241434c4541525f544553544e4554",
    );
  });

  test("produces decimal signature components in a JSON array", () => {
    const payload = signParadexAuthPayload({
      privateKey: TEST_KEY,
      accountAddress: TEST_ADDRESS,
      chainId: TEST_CHAIN,
      timestamp: 1_700_000_000,
      expiration: 1_700_000_300,
    });

    const parts = JSON.parse(payload) as string[];
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      // Hex components are rejected by the venue as INVALID_TOKEN.
      expect(part).toMatch(/^[0-9]+$/);
      expect(part.length).toBeGreaterThan(60);
    }
  });

  test("is deterministic for the same inputs", () => {
    const sign = () =>
      signParadexAuthPayload({
        privateKey: TEST_KEY,
        accountAddress: TEST_ADDRESS,
        chainId: TEST_CHAIN,
        timestamp: 1_700_000_000,
        expiration: 1_700_000_300,
      });

    expect(sign()).toBe(sign());
  });
});

describe("Paradex JWT expiry", () => {
  test("reads exp and returns milliseconds", () => {
    expect(readParadexJwtExpiryMs(fakeJwt(1_700_000_300))).toBe(
      1_700_000_300_000,
    );
  });

  test("returns null for malformed tokens", () => {
    expect(readParadexJwtExpiryMs("not-a-jwt")).toBeNull();
    expect(readParadexJwtExpiryMs("a.!!!.c")).toBeNull();
  });
});

describe("Paradex auth request", () => {
  test("posts signed headers and returns the token", async () => {
    const token = fakeJwt(1_700_000_300);
    const calls: Array<{ url: string; init: RequestInit }> = [];

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/system/config")) {
        return jsonResponse({ starknet_chain_id: TEST_CHAIN });
      }
      return jsonResponse({ jwt_token: token });
    }) as unknown as typeof fetch;

    const result = await fetchParadexAuthToken({
      environment: TEST_ENVIRONMENT,
      accountAddress: TEST_ADDRESS,
      publicKey: TEST_PUBLIC_KEY,
      privateKey: TEST_KEY,
      strategy: "auto",
    });

    expect(result.token).toBe(token);
    expect(result.endpoint).toBe("/auth");

    const authCall = calls.find((call) => call.url.endsWith("/auth"))!;
    const headers = authCall.init.headers as Record<string, string>;
    expect(headers["PARADEX-STARKNET-ACCOUNT"]).toBe(TEST_ADDRESS);
    expect(headers["PARADEX-TIMESTAMP"]).toMatch(/^\d{10}$/);
    expect(headers["PARADEX-SIGNATURE-EXPIRATION"]).toMatch(/^\d{10}$/);
    expect(JSON.parse(headers["PARADEX-STARKNET-SIGNATURE"]!)).toHaveLength(2);
  });

  test("falls back to the subkey endpoint when the signature does not verify", async () => {
    const token = fakeJwt(1_700_000_300);
    const authPaths: string[] = [];

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/system/config")) {
        return jsonResponse({ starknet_chain_id: TEST_CHAIN });
      }
      const path = new URL(url).pathname;
      authPaths.push(path);
      if (path === "/v1/auth") {
        return jsonResponse(
          {
            error: "STARKNET_SIGNATURE_VERIFICATION_FAILED",
            message: "verification failed on Curve",
          },
          401,
        );
      }
      return jsonResponse({ jwt_token: token });
    }) as unknown as typeof fetch;

    const result = await fetchParadexAuthToken({
      environment: TEST_ENVIRONMENT,
      accountAddress: TEST_ADDRESS,
      publicKey: TEST_PUBLIC_KEY,
      privateKey: TEST_KEY,
      strategy: "auto",
    });

    expect(authPaths).toEqual(["/v1/auth", `/v1/auth/${TEST_PUBLIC_KEY}`]);
    expect(result.endpoint).toBe(`/auth/${TEST_PUBLIC_KEY}`);
  });

  test("does not fall back when the account endpoint reports another failure", async () => {
    const authPaths: string[] = [];

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/system/config")) {
        return jsonResponse({ starknet_chain_id: TEST_CHAIN });
      }
      authPaths.push(new URL(url).pathname);
      return jsonResponse({ error: "NOT_ONBOARDED" }, 400);
    }) as unknown as typeof fetch;

    await expect(
      fetchParadexAuthToken({
        environment: TEST_ENVIRONMENT,
        accountAddress: TEST_ADDRESS,
        publicKey: TEST_PUBLIC_KEY,
        privateKey: TEST_KEY,
        strategy: "auto",
      }),
    ).rejects.toThrow(ExchangeConfigurationError);

    expect(authPaths).toEqual(["/v1/auth"]);
  });

  test("honors an explicit subkey strategy", async () => {
    const token = fakeJwt(1_700_000_300);
    const authPaths: string[] = [];

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/system/config")) {
        return jsonResponse({ starknet_chain_id: TEST_CHAIN });
      }
      authPaths.push(new URL(url).pathname);
      return jsonResponse({ jwt_token: token });
    }) as unknown as typeof fetch;

    const result = await fetchParadexAuthToken({
      environment: TEST_ENVIRONMENT,
      accountAddress: TEST_ADDRESS,
      publicKey: TEST_PUBLIC_KEY,
      privateKey: TEST_KEY,
      strategy: "subkey",
    });

    expect(authPaths).toEqual([`/v1/auth/${TEST_PUBLIC_KEY}`]);
    expect(result.endpoint).toBe(`/auth/${TEST_PUBLIC_KEY}`);
  });

  test("never puts the private key in the error message", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/system/config")) {
        return jsonResponse({ starknet_chain_id: TEST_CHAIN });
      }
      return jsonResponse({ error: "INVALID_TOKEN" }, 401);
    }) as unknown as typeof fetch;

    let error: unknown;
    try {
      await fetchParadexAuthToken({
        environment: TEST_ENVIRONMENT,
        accountAddress: TEST_ADDRESS,
        publicKey: TEST_PUBLIC_KEY,
        privateKey: TEST_KEY,
        strategy: "account",
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ExchangeConfigurationError);
    expect((error as Error).message).not.toContain(TEST_KEY);
  });
});

describe("Paradex auth strategy configuration", () => {
  test("defaults to auto", () => {
    expect(loadParadexConfig({}).authStrategy).toBe("auto");
  });

  test("accepts account and subkey", () => {
    expect(loadParadexConfig({ PARADEX_AUTH_MODE: "account" }).authStrategy).toBe(
      "account",
    );
    expect(loadParadexConfig({ PARADEX_AUTH_MODE: "subkey" }).authStrategy).toBe(
      "subkey",
    );
  });

  test("rejects unknown strategies instead of guessing", () => {
    expect(() =>
      loadParadexConfig({ PARADEX_AUTH_MODE: "wallet" }),
    ).toThrow(ExchangeConfigurationError);
  });
});
