/**
 * Exchange-agnostic market data and trading types.
 *
 * Strategy, risk and portfolio code must depend on these types only. Nothing
 * in this file may reference a concrete venue such as ApeX or CCXT.
 */

export type ExchangeEnvironment = "mainnet" | "testnet";

export type MarketType = "spot" | "swap" | "future";

export type PositionSide = "long" | "short";

export type OrderSide = "buy" | "sell";

export type OrderType = "market" | "limit";

export type OrderStatus =
  | "open"
  | "closed"
  | "canceled"
  | "expired"
  | "rejected"
  | "unknown";

export interface MarketInfo {
  exchange: string;
  /** Unified symbol, e.g. `BTC/USDT:USDT`. */
  symbol: string;
  /** Exchange-native symbol, e.g. `BTC-USDT`. */
  exchangeSymbol: string;
  base: string;
  quote: string;
  settle: string;
  type: MarketType;
  linear: boolean;
  inverse: boolean;
  contract: boolean;
  active: boolean;
  contractSize: number | null;
  priceTick: number | null;
  amountStep: number | null;
  minAmount: number | null;
  maxAmount: number | null;
  minCost: number | null;
  minLeverage: number | null;
  maxLeverage: number | null;
  initialMarginRate: number | null;
  maintenanceMarginRate: number | null;
  makerFee: number | null;
  takerFee: number | null;
  /** Unmodified exchange payload, kept for auditing. */
  raw: unknown;
}

export interface Candle {
  symbol: string;
  timeframe: string;
  /** Open time in UTC epoch milliseconds. */
  openTime: number;
  /** Open time plus one timeframe interval, in UTC epoch milliseconds. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
  /**
   * False when the candle's interval has not elapsed yet. Research code must
   * ignore non-final candles.
   */
  isFinal: boolean;
}

export interface Trade {
  id: string | null;
  symbol: string;
  side: OrderSide | null;
  price: number;
  amount: number;
  timestamp: number | null;
  raw: unknown;
}

export interface Ticker {
  symbol: string;
  timestamp: number | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  raw: unknown;
}

export interface OrderBookLevel {
  price: number;
  amount: number;
}

export interface OrderBook {
  symbol: string;
  timestamp: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface FundingRate {
  symbol: string;
  /** Settlement time in UTC epoch milliseconds. */
  timestamp: number | null;
  rate: number;
  raw: unknown;
}

export interface BalanceEntry {
  currency: string;
  total: number;
  free: number;
  used: number;
}

export interface Position {
  symbol: string;
  side: PositionSide;
  contracts: number;
  contractSize: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  unrealizedPnl: number | null;
  leverage: number | null;
  raw: unknown;
}

export interface Order {
  id: string | null;
  clientOrderId: string | null;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  price: number | null;
  amount: number | null;
  /** Venue-reported average fill price, when the venue provides one. */
  average?: number | null;
  filled: number | null;
  remaining: number | null;
  status: OrderStatus;
  timestamp: number | null;
  raw: unknown;
}

/**
 * Order lifetime. Venues differ in their default: Lighter defaults to GTT, so
 * a "market" order without an explicit IOC can rest on the book and fill later.
 */
export type OrderTimeInForce = "GTC" | "IOC" | "FOK" | "GTT";

export interface OrderRequest {
  symbol: string;
  type: OrderType;
  side: OrderSide;
  amount: number;
  /**
   * Required for limit orders. ApeX also requires a worst price for market
   * orders because the price is part of its ZK signature.
   */
  price?: number;
  clientOrderId?: string;
  reduceOnly?: boolean;
  /**
   * Explicit lifetime. Execution paths that intend an immediate fill must send
   * `IOC`; an unfilled remainder is then canceled by the venue instead of
   * resting as an untracked working order.
   */
  timeInForce?: OrderTimeInForce;
}

export interface ExchangeAdapter {
  readonly id: string;

  connect(): Promise<void>;
  close(): Promise<void>;

  getServerTime(): Promise<number>;
  getMarkets(): Promise<MarketInfo[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
  getTrades(symbol: string, since?: number, limit?: number): Promise<Trade[]>;
  /**
   * Returns candles sorted oldest first. `until` is an exclusive upper bound in
   * epoch milliseconds, used by venues that page backwards from the newest
   * candle.
   */
  getOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
    until?: number,
  ): Promise<Candle[]>;
  getFundingRates(
    symbol: string,
    since?: number,
    limit?: number,
  ): Promise<FundingRate[]>;

  getBalance(): Promise<BalanceEntry[]>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(symbol?: string): Promise<Order[]>;

  createOrder(request: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
}
