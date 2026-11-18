import type { MarketInterface } from "ccxt";
import { UnsupportedOperationError } from "../exchange.errors";
import type {
  BalanceEntry,
  Candle,
  ExchangeAdapter,
  FundingRate,
  MarketInfo,
  Order,
  OrderBook,
  OrderRequest,
  Position,
  Ticker,
  Trade,
} from "../exchange.types";
import {
  normalizeBalance,
  normalizeCandle,
  normalizeFundingRate,
  normalizeOrder,
  normalizeOrderBook,
  normalizePosition,
  normalizeTicker,
  normalizeTrade,
  redactMessage,
  timeframeToMs,
  type RawBalances,
} from "../normalizers";
import {
  authenticateParadexClient,
  refreshParadexAuthIfNeeded,
  type ParadexAuthToken,
} from "./paradex.auth";
import {
  createParadexPrivateClient,
  createParadexPublicClient,
  loadParadexPerpetualMarkets,
  type ParadexClient,
} from "./paradex.client";
import {
  assertParadexOrderSubmissionAllowed,
  loadParadexConfig,
  type ParadexConfig,
} from "./paradex.config";
import {
  isEligibleParadexPerpetual,
  normalizeParadexMarket,
} from "./paradex.market-mapper";

/**
 * Paradex caps a kline response by bars in the requested window. 1000 bars is
 * the documented reliable maximum used by CCXT, so larger requests are clamped
 * rather than allowed to fail server-side.
 */
const MAX_CANDLES_PER_REQUEST = 1000;

/** Timeframes the Paradex kline endpoint accepts. */
const SUPPORTED_TIMEFRAMES = new Set([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
]);

export interface ParadexAdapterOptions {
  config?: ParadexConfig;
}

/**
 * Paradex implementation of the exchange-agnostic adapter.
 *
 * Market data uses an unauthenticated client. Account reads use a separate,
 * explicitly enabled client. Order placement is refused unless the live
 * trading gates in ParadexConfig are all open.
 */
export class ParadexAdapter implements ExchangeAdapter {
  readonly id = "paradex";

  private readonly config: ParadexConfig;
  private readonly publicClient: ParadexClient;
  private privateClient: ParadexClient | null = null;
  private authInfo: ParadexAuthToken | null = null;
  private markets: MarketInfo[] | null = null;

  constructor(options: ParadexAdapterOptions = {}) {
    this.config = options.config ?? loadParadexConfig();
    this.publicClient = createParadexPublicClient(this.config);
  }

  getConfig(): ParadexConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    // The unfiltered Paradex market list is ~16 MB because it includes every
    // option series. The engine only trades perpetuals, and the filtered
    // endpoint is ~65 KB, so always ask for PERP markets explicitly.
    await loadParadexPerpetualMarkets(this.publicClient);
    this.markets = (
      Object.values(this.publicClient.markets ?? {}) as MarketInterface[]
    )
      .map((market) => normalizeParadexMarket(this.publicClient.id, market))
      .filter((market): market is MarketInfo => market !== null);
  }

  async close(): Promise<void> {
    this.markets = null;
    this.privateClient = null;
  }

  async getServerTime(): Promise<number> {
    return Number(await this.publicClient.fetchTime());
  }

  async getMarkets(): Promise<MarketInfo[]> {
    if (!this.markets) await this.connect();
    return this.markets ?? [];
  }

  async getEligibleMarkets(): Promise<MarketInfo[]> {
    return (await this.getMarkets()).filter(isEligibleParadexPerpetual);
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const ticker = await this.publicClient.fetchTicker(symbol);
    return normalizeTicker(ticker, symbol);
  }

  async getOrderBook(symbol: string, limit = 25): Promise<OrderBook> {
    const book = await this.publicClient.fetchOrderBook(symbol, limit);
    return normalizeOrderBook(book, symbol);
  }

  async getTrades(
    symbol: string,
    since?: number,
    limit = 50,
  ): Promise<Trade[]> {
    const trades = await this.publicClient.fetchTrades(symbol, since, limit);
    return trades
      .map((trade) => normalizeTrade(trade, symbol))
      .filter((trade): trade is Trade => trade !== null);
  }

  async getOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit = MAX_CANDLES_PER_REQUEST,
    until?: number,
  ): Promise<Candle[]> {
    // Validates the timeframe before a request is made.
    timeframeToMs(timeframe);

    if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
      throw new UnsupportedOperationError(
        `Paradex supports ${[...SUPPORTED_TIMEFRAMES].join(", ")}; received "${timeframe}"`,
      );
    }

    const requested = Math.max(
      1,
      Math.min(Math.trunc(limit), MAX_CANDLES_PER_REQUEST),
    );

    if (until !== undefined && since !== undefined && until <= since) {
      return [];
    }

    // `until` is exclusive in the adapter contract; Paradex `end_at` is
    // inclusive, so the bound is shifted back by one millisecond.
    const params: { until?: number } =
      until === undefined ? {} : { until: until - 1 };

    const rows = await this.publicClient.fetchOHLCV(
      symbol,
      timeframe,
      since,
      requested,
      params,
    );
    const now = Date.now();
    const byOpenTime = new Map<number, Candle>();

    for (const row of rows) {
      const candle = normalizeCandle(row, symbol, timeframe, now, {
        // Paradex carries the previous close into the interval open while
        // high/low only cover trades inside the interval.
        widenRange: true,
      });
      if (!candle) continue;
      if (since !== undefined && candle.openTime < since) continue;
      if (until !== undefined && candle.openTime >= until) continue;
      byOpenTime.set(candle.openTime, candle);
    }

    return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async getFundingRates(
    symbol: string,
    since?: number,
    limit = 100,
  ): Promise<FundingRate[]> {
    const rows = await this.publicClient.fetchFundingRateHistory(
      symbol,
      since,
      limit,
    );

    return rows
      .map((row) => normalizeFundingRate(row, symbol))
      .filter((row): row is FundingRate => row !== null);
  }

  async getBalance(): Promise<BalanceEntry[]> {
    const balance = await (await this.getPrivateClient()).fetchBalance();
    return normalizeBalance(balance as unknown as RawBalances);
  }

  async getPositions(): Promise<Position[]> {
    const positions = await (await this.getPrivateClient()).fetchPositions();

    return positions
      .map((position) => normalizePosition(position))
      .filter((position): position is Position => position !== null);
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const orders = await (await this.getPrivateClient()).fetchOpenOrders(
      symbol,
    );

    return orders
      .map((order) => normalizeOrder(order))
      .filter((order): order is Order => order !== null);
  }

  async createOrder(request: OrderRequest): Promise<Order> {
    assertParadexOrderSubmissionAllowed(this.config);

    if (request.type === "limit" && request.price === undefined) {
      throw new UnsupportedOperationError(
        "Paradex limit orders require an explicit price",
      );
    }

    const order = await (await this.getPrivateClient()).createOrder(
      request.symbol,
      request.type,
      request.side,
      request.amount,
      request.price,
      {
        ...(request.clientOrderId
          ? { clientOrderId: request.clientOrderId }
          : {}),
        ...(request.reduceOnly ? { reduceOnly: true } : {}),
      },
    );

    const normalized = normalizeOrder(order);
    if (!normalized) {
      throw new UnsupportedOperationError(
        `Paradex returned an order that could not be normalized: ${JSON.stringify(order)}`,
      );
    }

    return normalized;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    assertParadexOrderSubmissionAllowed(this.config);
    await (await this.getPrivateClient()).cancelOrder(orderId, symbol);
  }

  private async getPrivateClient(): Promise<ParadexClient> {
    if (!this.privateClient) {
      const client = createParadexPrivateClient(this.config);
      // Preload only perpetuals so private calls do not download the full
      // option-heavy market list on first use.
      await loadParadexPerpetualMarkets(client);
      // CCXT only signs in with the account's main key. Minting the JWT here
      // also covers subkeys and is reused by every private call.
      this.authInfo = await authenticateParadexClient(client, this.config);
      this.privateClient = client;
    } else {
      await refreshParadexAuthIfNeeded(this.privateClient, this.config);
    }

    return this.privateClient;
  }

  /** Which auth endpoint the private key was accepted at, once known. */
  getAuthInfo(): { endpoint: string; expiresAtMs: number } | null {
    if (!this.authInfo) return null;
    return {
      endpoint: this.authInfo.endpoint,
      expiresAtMs: this.authInfo.expiresAtMs,
    };
  }

  /** Safe error text for logs; never includes account keys. */
  redact(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactMessage(message, [
      this.config.credentials.evmPrivateKey,
      this.config.credentials.paradexPrivateKey,
      this.config.credentials.paradexPublicKey,
      this.config.credentials.paradexAddress,
    ]);
  }
}

export function createParadexAdapter(
  options: ParadexAdapterOptions = {},
): ParadexAdapter {
  return new ParadexAdapter(options);
}
