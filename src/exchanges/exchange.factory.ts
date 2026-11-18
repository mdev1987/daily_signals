import type { ExchangeAdapter } from "./exchange.types";
import { createApexAdapter } from "./apex/apex.adapter";
import { createParadexAdapter } from "./paradex/paradex.adapter";
import { createLighterAdapter } from "./lighter/lighter.adapter";
import { normalizeExchangeId } from "./exchange.profile";

export type { ExchangeId } from "./exchange.profile";

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
  const id = normalizeExchangeId(options.exchange);

  switch (id) {
    case "apex":
      return createApexAdapter();
    case "paradex":
      return createParadexAdapter();
    case "lighter":
      return createLighterAdapter();
  }
}
