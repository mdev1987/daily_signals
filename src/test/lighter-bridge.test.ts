import { describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { LighterAdapter } from "../exchanges/lighter/lighter.adapter";
import { loadLighterConfig } from "../exchanges/lighter/lighter.config";
import {
  LighterExecutionBridge,
  type PaperExecutionPosition,
} from "../exchanges/lighter/lighter.execution";

const ENV = {
  LIGHTER_PRIVATE_KEY: "a".repeat(80),
  LIGHTER_PUBLIC_KEY: "b".repeat(80),
  LIGHTER_ACCOUNT_INDEX: "1",
  LIGHTER_KEY_INDEX: "4",
  LIGHTER_PRIVATE_API_ENABLED: "true",
  LIGHTER_ORDER_SUBMISSION_ENABLED: "true",
  LIGHTER_EXECUTION_ENABLED: "true",
  TRADING_MODE: "live",
  LIVE_TRADING_ENABLED: "true",
};

const SYMBOL = "BTC/USDC:USDC";

function fakeAdapter(opts: { positions?: any[]; free?: number } = {}) {
  const orders: any[] = [];
  const adapter = {
    orders,
    positions: opts.positions ?? [],
    redact: (e: unknown) => String(e),
    getMarkets: async () => [
      { symbol: SYMBOL, amountStep: 0.0001, minAmount: 0.0002, minCost: 10 },
    ],
    getBalance: async () => [
      { currency: "USDC", total: 1000, free: opts.free ?? 1000, used: 0 },
    ],
    getOrderBook: async () => ({
      symbol: SYMBOL,
      timestamp: null,
      bids: [{ price: 100_000, amount: 1 }],
      asks: [{ price: 100_010, amount: 1 }],
    }),
    getTicker: async () => ({ last: 100_005 }),
    getPositions: async () => adapter.positions,
    setLeverage: async () => {},
    createOrder: async (req: any) => {
      orders.push(req);
      return { id: "o1", status: "open", raw: null };
    },
  };
  return adapter;
}

async function makeBridge(adapter: any, env: Record<string, string> = {}) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const bridge = new LighterExecutionBridge({
    connection: connection as any,
    config: loadLighterConfig({ ...ENV, ...env }),
    adapter: adapter as LighterAdapter,
    stopLossPct: 2,
    log: () => {},
    sleep: async () => {},
  });
  await (bridge as any).ensureAuditTable();
  return { bridge, connection };
}

const paper = (over: Partial<PaperExecutionPosition> = {}): PaperExecutionPosition => ({
  id: "p1",
  symbol: "BTC/USD",
  direction: "long",
  quantity: 0.001,
  entryPrice: 100_000,
  notional: 100,
  ...over,
});

describe("Lighter bridge", () => {
  test("open sends a leveraged market buy with a worst price", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(1);
    expect(a.orders[0].side).toBe("buy");
    expect(a.orders[0].amount).toBe(0.001);
    expect(a.orders[0].price).toBeGreaterThan(100_010);
    expect(a.orders[0].reduceOnly).toBeUndefined();
  });

  test("size multiplier scales the venue quantity", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a, { LIGHTER_SIZE_MULTIPLIER: "5" });
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders[0].amount).toBe(0.005);
  });

  test("open is skipped when the venue already holds a position", async () => {
    const a = fakeAdapter({ positions: [{ symbol: SYMBOL, side: "long", contracts: 0.01 }] });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("open is skipped when free margin is insufficient", async () => {
    const a = fakeAdapter({ free: 1 });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper({ quantity: 0.01 }));
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("close with no venue position sends no order", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("close sends a reduce-only sell for the held size", async () => {
    const a = fakeAdapter({ positions: [{ symbol: SYMBOL, side: "long", contracts: 0.003 }] });
    const { bridge } = await makeBridge(a);
    bridge.onClose(paper(), "TAKE_PROFIT");
    await bridge.flush();
    expect(a.orders[0]).toMatchObject({ side: "sell", amount: 0.003, reduceOnly: true });
  });

  test("reconcile closes an orphan venue position", async () => {
    const a = fakeAdapter({ positions: [{ symbol: SYMBOL, side: "short", contracts: 0.002 }] });
    const { bridge } = await makeBridge(a);
    bridge.reconcile([]);
    await bridge.flush();
    expect(a.orders[0]).toMatchObject({ side: "buy", reduceOnly: true });
  });

  test("leverage that liquidates before the stop is refused", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a, { LIGHTER_LEVERAGE: "50" });
    await expect(bridge.connect()).rejects.toThrow(/liquidation/);
  });

  test("non-USD crypto crosses never reach the venue", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper({ symbol: "BTC/ZAR" }));
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });
});
