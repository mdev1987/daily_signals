import type { MarketInterface } from "ccxt";
import {
  ExchangeConfigurationError,
  UnsupportedOperationError,
} from "../exchange.errors";
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
  createLighterPrivateClient,
  createLighterPublicClient,
  ensureLighterSigner,
  loadLighterMarkets,
  type LighterClient,
  type LighterRawApi,
} from "./lighter.client";
import {
  assertLighterOrderSubmissionAllowed,
  loadLighterConfig,
  type LighterConfig,
  type LighterMarginMode,
} from "./lighter.config";
import {
  isEligibleLighterPerpetual,
  normalizeLighterMarket,
} from "./lighter.market-mapper";

/** Lighter returns at most 500 candles per request, documented. */
const MAX_CANDLES_PER_REQUEST = 500;

/** Lighter's candles endpoint accepts these resolutions only. */
const SUPPORTED_TIMEFRAMES = new Set([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
]);

/** The fundings endpoint returns at most 750 entries per request. */
const MAX_FUNDING_ENTRIES = 750;

interface RawFundingEntry {
  timestamp?: unknown;
  rate?: unknown;
}

/**
 * Converts Lighter funding rows into the internal type. Lighter reports the
 * settlement time in Unix seconds, while the engine stores milliseconds.
 */
export function normalizeLighterFundingRows(
  rows: readonly unknown[],
  symbol: string,
  since?: number,
  limit = 100,
): FundingRate[] {
  const requested = Math.max(1, Math.trunc(limit));
  const rates: FundingRate[] = [];

  for (const row of rows as RawFundingEntry[]) {
    const seconds = Number(row?.timestamp);
    const rate = Number(row?.rate);

    if (!Number.isFinite(seconds) || !Number.isFinite(rate)) continue;

    const timestamp = Math.trunc(seconds) * 1000;
    if (since !== undefined && timestamp < since) continue;

    rates.push({ symbol, timestamp, rate, raw: row });
  }

  return rates
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(-requested);
}

export interface LighterAdapterOptions {
  config?: LighterConfig;
}

/**
 * Lighter implementation of the exchange-agnostic adapter.
 *
 * Market data uses an unauthenticated client. Account reads use a separate,
 * explicitly enabled client that CCXT signs with the wasm signer. Order
 * placement is refused unless the trading gates in LighterConfig are open.
 */
/**
 * Lighter accepts GTT and IOC only; CCXT documents GTT as its default. Any
 * other value (GTC, FOK) is rejected here rather than silently sent to a venue
 * that does not understand it.
 */
export function resolveLighterTimeInForce(
  request: Pick<OrderRequest, "type" | "timeInForce">,
): "GTT" | "IOC" {
  const requested =
    request.timeInForce ?? (request.type === "market" ? "IOC" : "GTT");

  if (requested !== "GTT" && requested !== "IOC") {
    throw new UnsupportedOperationError(
      `Lighter accepts only GTT and IOC time-in-force; received ${requested}`,
    );
  }

  return requested;
}

export class LighterAdapter implements ExchangeAdapter {
  readonly id = "lighter";

  private readonly config: LighterConfig;
  private readonly publicClient: LighterClient;
  private privateClient: LighterClient | null = null;
  private markets: MarketInfo[] | null = null;

  constructor(options: LighterAdapterOptions = {}) {
    this.config = options.config ?? loadLighterConfig();
    this.publicClient = createLighterPublicClient(this.config);
  }

  getConfig(): LighterConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    await loadLighterMarkets(this.publicClient);
    this.markets = (
      Object.values(this.publicClient.markets ?? {}) as MarketInterface[]
    )
      .map((market) => normalizeLighterMarket(this.publicClient.id, market))
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
    return (await this.getMarkets()).filter(isEligibleLighterPerpetual);
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
        `Lighter supports ${[...SUPPORTED_TIMEFRAMES].join(", ")}; received "${timeframe}"`,
      );
    }

    const requested = Math.max(
      1,
      Math.min(Math.trunc(limit), MAX_CANDLES_PER_REQUEST),
    );

    if (until !== undefined && since !== undefined && until <= since) {
      return [];
    }

    const params: { until?: number } =
      until === undefined ? {} : { until };

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
        // Lighter omits zero-valued fields, including volume on intervals
        // without trades. The price candle is real, so the volume is zero.
        zeroMissingVolume: true,
      });
      if (!candle) continue;
      if (since !== undefined && candle.openTime < since) continue;
      if (until !== undefined && candle.openTime >= until) continue;
      byOpenTime.set(candle.openTime, candle);
    }

    return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
  }

  /**
   * Funding history. Lighter's documented history endpoint reports 1h or 1d
   * entries, so the adapter asks for 1h and returns at most `limit` of them.
   */
  async getFundingRates(
    symbol: string,
    since?: number,
    limit = 100,
  ): Promise<FundingRate[]> {
    const market = await this.getMarket(symbol);
    const requested = Math.max(
      1,
      Math.min(Math.trunc(limit), MAX_FUNDING_ENTRIES),
    );
    const end = Date.now();
    const start = since ?? end - requested * 3_600_000;

    const raw = this.publicClient as unknown as LighterRawApi;
    const response = await raw.publicGetFundings({
      market_id: Number(market.exchangeSymbol),
      resolution: "1h",
      start_timestamp: start,
      end_timestamp: end,
      count_back: 0,
    });

    const rows = Array.isArray(response.fundings) ? response.fundings : [];

    return normalizeLighterFundingRows(rows, symbol, since, requested);
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
    const client = await this.getPrivateClient();

    if (symbol) {
      const orders = await client.fetchOpenOrders(symbol);
      return orders
        .map((order) => normalizeOrder(order))
        .filter((order): order is Order => order !== null);
    }

    // CCXT's fetchOpenOrders() requires a symbol. The documented endpoint makes
    // market_id optional, so one signed request can cover every market.
    const raw = client as unknown as LighterRawApi;
    const response = await raw.privateGetAccountActiveOrders({
      account_index: this.config.credentials.accountIndex,
    });

    const orders = Array.isArray(response.orders) ? response.orders : [];
    const marketsById = new Map(
      (Object.values(client.markets ?? {}) as MarketInterface[]).map(
        (market) => [String(market.id), market],
      ),
    );

    return orders
      .map((order) => {
        const marketId = String(
          (order as Record<string, unknown>).market_index ?? "",
        );
        const market = marketsById.get(marketId);

        const parsed = client.parseOrder(
          order as Record<string, unknown>,
          market,
        );

        return normalizeOrder(
          parsed as Parameters<typeof normalizeOrder>[0],
        );
      })
      .filter((order): order is Order => order !== null);
  }

  async createOrder(request: OrderRequest): Promise<Order> {
    // Validate the lifetime first: a value Lighter cannot honor must never be
    // passed through to CCXT on a future limit order.
    const timeInForce = resolveLighterTimeInForce(request);

    assertLighterOrderSubmissionAllowed(this.config);

    // Lighter signs the price into the order even for market orders: it is the
    // worst acceptable execution price, so it cannot be omitted.
    if (request.price === undefined) {
      throw new UnsupportedOperationError(
        "Lighter requires a price for every order, including market orders " +
          "(it is the worst acceptable execution price)",
      );
    }

    const order = await (await this.getPrivateClient()).createOrder(
      request.symbol,
      request.type,
      request.side,
      request.amount,
      request.price,
      {
        timeInForce,
        ...(request.clientOrderId
          ? { clientOrderId: request.clientOrderId }
          : {}),
        ...(request.reduceOnly ? { reduceOnly: true } : {}),
      },
    );

    const normalized = normalizeOrder(order);
    if (!normalized) {
      throw new UnsupportedOperationError(
        `Lighter returned an order that could not be normalized: ${JSON.stringify(order)}`,
      );
    }

    return normalized;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    assertLighterOrderSubmissionAllowed(this.config);
    await (await this.getPrivateClient()).cancelOrder(orderId, symbol);
  }

  /**
   * Sets the account's leverage for one market. Lighter stores the initial
   * margin fraction per account and market, so this is a signed transaction
   * rather than a local setting.
   */
  async setLeverage(
    symbol: string,
    leverage: number,
    marginMode: LighterMarginMode,
  ): Promise<void> {
    assertLighterOrderSubmissionAllowed(this.config);

    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new ExchangeConfigurationError(
        `Lighter leverage must be a positive integer, received "${leverage}"`,
      );
    }

    await (await this.getPrivateClient()).setLeverage(leverage, symbol, {
      marginMode,
    });
  }

  /** Non-secret identity of the private client, once it is ready. */
  getAuthInfo(): {
    accountIndex: number | null;
    apiKeyIndex: number | null;
    chainId: number;
    baseUrl: string;
  } {
    return {
      accountIndex: this.config.credentials.accountIndex,
      apiKeyIndex: this.config.credentials.apiKeyIndex,
      chainId: this.config.chainId,
      baseUrl: this.config.baseUrls[this.config.privateApiEnvironment],
    };
  }

  /** Safe error text for logs; never includes the API key. */
  redact(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactMessage(message, [this.config.credentials.apiKey]);
  }

  private async getMarket(symbol: string): Promise<MarketInfo> {
    const markets = await this.getMarkets();
    const market = markets.find((candidate) => candidate.symbol === symbol);

    if (!market) {
      throw new UnsupportedOperationError(
        `Lighter market "${symbol}" is not loaded`,
      );
    }

    return market;
  }

  private async getPrivateClient(): Promise<LighterClient> {
    if (!this.privateClient) {
      const client = createLighterPrivateClient(this.config);
      await loadLighterMarkets(client);
      // Minting a token requires the wasm signer; failing here keeps every
      // private call behind a verified signer setup.
      await ensureLighterSigner(client, this.config);
      this.privateClient = client;
    }

    return this.privateClient;
  }
}

export function createLighterAdapter(
  options: LighterAdapterOptions = {},
): LighterAdapter {
  return new LighterAdapter(options);
}
