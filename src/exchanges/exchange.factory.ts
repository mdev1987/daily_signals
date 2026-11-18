import { ExchangeConfigurationError } from "./exchange.errors";
import type { ExchangeAdapter } from "./exchange.types";
import { createApexAdapter } from "./apex/apex.adapter";

export type ExchangeId = "apex";

export interface ExchangeFactoryOptions {
  exchange?: string;
}

/**
 * Single place where a concrete exchange adapter is chosen. Research code
 * receives an ExchangeAdapter and never imports a venue SDK.
 */
export function createExchangeAdapter(
  options: ExchangeFactoryOptions = {},
): ExchangeAdapter {
  const id = (options.exchange ?? process.env.EXCHANGE ?? "apex")
    .trim()
    .toLowerCase();

  switch (id) {
    case "apex":
      return createApexAdapter();
    default:
      throw new ExchangeConfigurationError(
        `Unsupported exchange "${id}". Available adapters: apex`,
      );
  }
}
