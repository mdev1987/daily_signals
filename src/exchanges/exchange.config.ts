import { ExchangeConfigurationError } from "./exchange.errors";
import type { ExchangeEnvironment } from "./exchange.types";

export type TradingMode = "paper" | "live";

/**
 * Normalizes an environment variable into a known environment. Unknown values
 * throw instead of silently falling back, because a typo must never switch a
 * run onto the wrong network.
 */
export function readExchangeEnvironment(
  value: string | undefined,
  fallback: ExchangeEnvironment,
  name: string,
): ExchangeEnvironment {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return fallback;
  if (
    normalized === "mainnet" ||
    normalized === "prod" ||
    normalized === "production"
  ) {
    return "mainnet";
  }
  if (normalized === "testnet" || normalized === "qa" || normalized === "sandbox") {
    return "testnet";
  }

  throw new ExchangeConfigurationError(
    `${name} must be "mainnet" or "testnet", received "${value}"`,
  );
}

export function readBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return fallback;
}

export function readTradingMode(value: string | undefined): TradingMode {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return "paper";
  if (normalized === "paper") return "paper";
  if (normalized === "live") return "live";

  throw new ExchangeConfigurationError(
    `TRADING_MODE must be "paper" or "live", received "${value}"`,
  );
}
