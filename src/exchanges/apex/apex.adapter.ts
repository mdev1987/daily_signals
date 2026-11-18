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
  createApexPrivateClient,
  createApexPublicClient,
  type ApexClient,
} from "./apex.client";
import {
  assertOrderSubmissionAllowed,
  loadApexConfig,
  type ApexConfig,
} from "./apex.config";
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
  isEligibleApexPerpetual,
  normalizeApexMarket,
} from "./apex.market-mapper";

const MAX_CANDLES_PER_REQUEST = 200;

export interface ApexAdapterOptions {
  config?: ApexConfig;
}

/**
 * ApeX Omni implementation of the exchange-agnostic adapter.
 *
 * Market data uses an unauthenticated client. Account reads use a separate,
 * explicitly enabled client. Order placement is refused unless the live
 * trading gates in ApexConfig are all open.
 */
export class ApexAdapter implements ExchangeAdapter {
  readonly id = "apex";

  private readonly config: ApexConfig;
  private readonly publicClient: ApexClient;
  private privateClient: ApexClient | null = null;
  private markets: MarketInfo[] | null = null;

  constructor(options: ApexAdapterOptions = {}) {
    this.config = options.config ?? loadApexConfig();
    this.publicClient = createApexPublicClient(this.config);
  }

  getConfig(): ApexConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    await this.publicClient.loadMarkets();
    this.markets = (
      Object.values(this.publicClient.markets ?? {}) as MarketInterface[]
    )
      .map((market) => normalizeApexMarket(this.publicClient.id, market))
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
    return (await this.getMarkets()).filter(isEligibleApexPerpetual);
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

    const requested = Math.max(
      1,
      Math.min(Math.trunc(limit), MAX_CANDLES_PER_REQUEST),
    );
    const rows = await this.publicClient.fetchOHLCV(
      symbol,
      timeframe,
      since,
      requested,
      until === undefined ? {} : { until },
    );
    const now = Date.now();
    const byOpenTime = new Map<number, Candle>();

    for (const row of rows) {
      const candle = normalizeCandle(row, symbol, timeframe, now);
      if (candle) byOpenTime.set(candle.openTime, candle);
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
    const balance = await this.getPrivateClient().fetchBalance();
    return normalizeBalance(balance as unknown as RawBalances);
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.getPrivateClient().fetchPositions();

    return positions
      .map((position) => normalizePosition(position))
      .filter((position): position is Position => position !== null);
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const orders = await this.getPrivateClient().fetchOpenOrders(symbol);

    return orders
      .map((order) => normalizeOrder(order))
      .filter((order): order is Order => order !== null);
  }

  async createOrder(request: OrderRequest): Promise<Order> {
    assertOrderSubmissionAllowed(this.config);

    if (request.type === "market" && request.price === undefined) {
      throw new UnsupportedOperationError(
        "ApeX requires a worst price for market orders because the price is " +
          "part of the ZK signature; pass request.price explicitly",
      );
    }

    const order = await this.getPrivateClient().createOrder(
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
        `ApeX returned an order that could not be normalized: ${JSON.stringify(order)}`,
      );
    }

    return normalized;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    assertOrderSubmissionAllowed(this.config);
    await this.getPrivateClient().cancelOrder(orderId, symbol);
  }

  private getPrivateClient(): ApexClient {
    if (!this.privateClient) {
      this.privateClient = createApexPrivateClient(this.config);
    }

    return this.privateClient;
  }

  /** Safe error text for logs; never includes the API key. */
  redact(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactMessage(message, [
      this.config.credentials.apiKey,
      this.config.credentials.secret,
      this.config.credentials.seeds,
    ]);
  }
}

export function createApexAdapter(
  options: ApexAdapterOptions = {},
): ApexAdapter {
  return new ApexAdapter(options);
}
