import * as Starknet from "starknet";
import { ExchangeConfigurationError } from "../exchange.errors";
import type { ExchangeEnvironment } from "../exchange.types";
import { redactMessage } from "../normalizers";
import {
  hasParadexStarknetCredentials,
  type ParadexAuthStrategy,
  type ParadexConfig,
} from "./paradex.config";

/**
 * The path an auth request signs.
 *
 * A subkey authenticates at `POST /v1/auth/{public_key}`, but the signed
 * message still says `/v1/auth`; only the address the server verifies against
 * changes. Signing the resolved path instead is rejected.
 */
export const PARADEX_AUTH_PATH = "/v1/auth";

/** Wallets are not involved, so a short TTL is enough and refreshed on demand. */
const AUTH_TTL_SECONDS = 300;

/** Re-mint a token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

const REQUEST_TIMEOUT_MS = 30_000;

const API_BASE_URLS: Record<ExchangeEnvironment, string> = {
  mainnet: "https://api.prod.paradex.trade/v1",
  testnet: "https://api.testnet.paradex.trade/v1",
};

/** Errors a main-key endpoint returns when the signer is a subkey. */
const SUBKEY_HINTS = new Set([
  "STARKNET_SIGNATURE_VERIFICATION_FAILED",
  "INVALID_SIGNATURE",
]);

interface TypedDataField {
  name: string;
  type: string;
}

export interface ParadexAuthTypedData {
  domain: { name: string; chainId: string; version: string };
  primaryType: "Request";
  types: {
    StarkNetDomain: TypedDataField[];
    Request: TypedDataField[];
  };
  message: {
    method: "POST";
    path: string;
    body: "";
    timestamp: number;
    expiration: number;
  };
}

export interface ParadexAuthToken {
  token: string;
  /** Expiry in milliseconds, as CCXT expects in `options.expires`. */
  expiresAtMs: number;
  /** Endpoint that accepted the signature. */
  endpoint: string;
}

const DOMAIN_FIELDS: TypedDataField[] = [
  { name: "name", type: "felt" },
  { name: "chainId", type: "felt" },
  { name: "version", type: "felt" },
];

const REQUEST_FIELDS: TypedDataField[] = [
  { name: "method", type: "felt" },
  { name: "path", type: "felt" },
  { name: "body", type: "felt" },
  { name: "timestamp", type: "felt" },
  { name: "expiration", type: "felt" },
];

/**
 * SNIP-12 typed data for `POST /v1/auth`.
 *
 * `chainId` is the venue chain id ("PRIVATE_SN_PARACLEAR_TESTNET") encoded as a
 * short string, and the timestamp/expiration are Unix **seconds**.
 */
export function buildParadexAuthTypedData(
  chainId: string,
  timestamp: number,
  expiration: number,
): ParadexAuthTypedData {
  return {
    domain: {
      name: "Paradex",
      chainId: Starknet.shortString.encodeShortString(chainId),
      version: "1",
    },
    primaryType: "Request",
    types: {
      StarkNetDomain: DOMAIN_FIELDS,
      Request: REQUEST_FIELDS,
    },
    message: {
      method: "POST",
      path: PARADEX_AUTH_PATH,
      body: "",
      timestamp,
      expiration,
    },
  };
}

/**
 * Signs an auth request and returns the header payload.
 *
 * Paradex expects the two signature components as **decimal strings** in a
 * JSON array. Hex components are rejected, which surfaces as an unhelpful
 * `INVALID_TOKEN` rather than a signature error.
 */
export function signParadexAuthPayload(params: {
  privateKey: string;
  accountAddress: string;
  chainId: string;
  timestamp: number;
  expiration: number;
}): string {
  const typedData = buildParadexAuthTypedData(
    params.chainId,
    params.timestamp,
    params.expiration,
  );

  const messageHash = Starknet.typedData.getMessageHash(
    typedData as unknown as Parameters<
      typeof Starknet.typedData.getMessageHash
    >[0],
    params.accountAddress,
  );

  const signature = Starknet.ec.starkCurve.sign(messageHash, params.privateKey);

  return JSON.stringify([signature.r.toString(), signature.s.toString()]);
}

/** Reads `exp` from a JWT without verifying it. Returns milliseconds. */
export function readParadexJwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function getParadexApiBaseUrl(
  environment: ExchangeEnvironment,
): string {
  return API_BASE_URLS[environment];
}

/** Venue chain id, cached per environment for the process lifetime. */
const chainIdCache = new Map<ExchangeEnvironment, string>();

async function getParadexChainId(
  environment: ExchangeEnvironment,
): Promise<string> {
  const cached = chainIdCache.get(environment);
  if (cached !== undefined) return cached;

  const base = getParadexApiBaseUrl(environment);
  const response = await fetch(`${base}/system/config`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ExchangeConfigurationError(
      `Paradex ${environment} system config request failed (${response.status})`,
    );
  }

  const config = (await response.json()) as { starknet_chain_id?: unknown };
  if (typeof config.starknet_chain_id !== "string") {
    throw new ExchangeConfigurationError(
      `Paradex ${environment} system config has no starknet_chain_id`,
    );
  }

  chainIdCache.set(environment, config.starknet_chain_id);
  return config.starknet_chain_id;
}

interface AuthAttempt {
  endpoint: string;
  ok: boolean;
  token?: string;
  error?: string;
}

async function requestAuthToken(params: {
  base: string;
  path: string;
  accountAddress: string;
  signature: string;
  timestamp: number;
  expiration: number;
}): Promise<AuthAttempt> {
  try {
    const response = await fetch(`${params.base}${params.path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "PARADEX-STARKNET-ACCOUNT": params.accountAddress,
        "PARADEX-STARKNET-SIGNATURE": params.signature,
        "PARADEX-TIMESTAMP": String(params.timestamp),
        "PARADEX-SIGNATURE-EXPIRATION": String(params.expiration),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as { jwt_token?: unknown };
      if (typeof parsed.jwt_token !== "string" || parsed.jwt_token === "") {
        return { endpoint: params.path, ok: false, error: "empty jwt_token" };
      }
      return { endpoint: params.path, ok: true, token: parsed.jwt_token };
    }

    return {
      endpoint: params.path,
      ok: false,
      error: `${response.status} ${text.slice(0, 200)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { endpoint: params.path, ok: false, error: message };
  }
}

function errorCode(text: string | undefined): string | null {
  if (!text) return null;
  const match = /"error"\s*:\s*"([A-Z0-9_]+)"/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Mints a JWT for an account keypair or a subkey.
 *
 * `auto` tries the account endpoint first (a main key works there) and falls
 * back to the subkey endpoint when the venue says the signature did not verify.
 * Any other failure is reported immediately so a wrong address is not hidden
 * behind a second failed attempt.
 */
export async function fetchParadexAuthToken(params: {
  environment: ExchangeEnvironment;
  accountAddress: string;
  publicKey: string;
  privateKey: string;
  strategy?: ParadexAuthStrategy;
}): Promise<ParadexAuthToken> {
  const strategy = params.strategy ?? "auto";
  const base = getParadexApiBaseUrl(params.environment);
  const chainId = await getParadexChainId(params.environment);

  const timestamp = Math.trunc(Date.now() / 1000);
  const expiration = timestamp + AUTH_TTL_SECONDS;

  const signature = signParadexAuthPayload({
    privateKey: params.privateKey,
    accountAddress: params.accountAddress,
    chainId,
    timestamp,
    expiration,
  });

  const endpoints =
    strategy === "account"
      ? ["/auth"]
      : strategy === "subkey"
        ? [`/auth/${params.publicKey}`]
        : ["/auth", `/auth/${params.publicKey}`];

  const attempts: AuthAttempt[] = [];

  for (const endpoint of endpoints) {
    const attempt = await requestAuthToken({
      base,
      path: endpoint,
      accountAddress: params.accountAddress,
      signature,
      timestamp,
      expiration,
    });

    if (attempt.ok && attempt.token) {
      return {
        token: attempt.token,
        expiresAtMs:
          readParadexJwtExpiryMs(attempt.token) ??
          (timestamp + AUTH_TTL_SECONDS) * 1000,
        endpoint: attempt.endpoint,
      };
    }

    attempts.push(attempt);

    const code = errorCode(attempt.error);
    const canFallBack = strategy === "auto" && attempts.length === 1;
    if (!canFallBack || code === null || !SUBKEY_HINTS.has(code)) {
      break;
    }
  }

  const details = attempts
    .map((attempt) => `${attempt.endpoint}: ${redactMessage(attempt.error ?? "failed")}`)
    .join("; ");

  throw new ExchangeConfigurationError(
    `Paradex authentication failed (${params.environment}). ${details}. ` +
      "Check that PARADEX_ADDRESS is the account the key belongs to and that " +
      "the key is the account's main key or a registered subkey.",
  );
}

/** Client surface needed to attach a minted token. */
export interface ParadexAuthTarget {
  options: Record<string, unknown>;
}

/**
 * Attaches a minted JWT to a CCXT client.
 *
 * CCXT re-signs on its own once `options.expires` passes, but it only knows the
 * account endpoint. Pre-seeding `authToken` makes every private call use the
 * already verified token, which is what lets a subkey work at all.
 */
export async function authenticateParadexClient(
  client: ParadexAuthTarget,
  config: ParadexConfig,
): Promise<ParadexAuthToken | null> {
  if (!hasParadexStarknetCredentials(config)) return null;

  const { paradexPrivateKey, paradexPublicKey, paradexAddress } =
    config.credentials;

  const auth = await fetchParadexAuthToken({
    environment: config.privateApiEnvironment,
    accountAddress: paradexAddress,
    publicKey: paradexPublicKey,
    privateKey: paradexPrivateKey,
    strategy: config.authStrategy,
  });

  client.options.authToken = auth.token;
  client.options.expires = auth.expiresAtMs;

  return auth;
}

/** Re-mints the token when it is close to expiry. */
export async function refreshParadexAuthIfNeeded(
  client: ParadexAuthTarget,
  config: ParadexConfig,
): Promise<void> {
  const expires = Number(client.options.expires ?? 0);
  if (Number.isFinite(expires) && expires - REFRESH_MARGIN_MS > Date.now()) {
    return;
  }

  await authenticateParadexClient(client, config);
}
