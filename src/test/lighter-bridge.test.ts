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

interface FakeOptions {
  positions?: any[];
  free?: number;
  balanceAvailable?: boolean;
  openOrders?: any[];
  leverageError?: boolean;
  /** Fraction of the requested size that the venue fills. */
  fillRatio?: number;
  /** Leverage the venue reports on the resulting position. */
  reportedLeverage?: number;
}

function fakeAdapter(opts: FakeOptions = {}) {
  const orders: any[] = [];
  const fillRatio = opts.fillRatio ?? 1;

  const adapter: any = {
    orders,
    positions: [...(opts.positions ?? [])],
    closed: false,
    redact: (e: unknown) => String(e),
    connect: async () => {},
    close: async () => {
      adapter.closed = true;
    },
    getAuthInfo: () => ({
      accountIndex: 1,
      apiKeyIndex: 4,
      chainId: 300,
      baseUrl: "https://example.test",
    }),
    getMarkets: async () => [
      { symbol: SYMBOL, amountStep: 0.0001, minAmount: 0.0002, minCost: 10 },
    ],
    getBalance: async () =>
      opts.balanceAvailable === false
        ? []
        : [{ currency: "USDC", total: 1000, free: opts.free ?? 1000, used: 0 }],
    getOrderBook: async () => ({
      symbol: SYMBOL,
      timestamp: null,
      bids: [{ price: 100_000, amount: 1 }],
      asks: [{ price: 100_010, amount: 1 }],
    }),
    getTicker: async () => ({ last: 100_005 }),
    getOpenOrders: async () => opts.openOrders ?? [],
    getPositions: async () => adapter.positions,
    setLeverage: async () => {
      if (opts.leverageError) throw new Error("leverage rejected");
    },
    createOrder: async (req: any) => {
      orders.push(req);

      if (req.reduceOnly) {
        const target = req.side === "sell" ? "long" : "short";
        adapter.positions = adapter.positions.filter(
          (position: any) =>
            !(position.symbol === req.symbol && position.side === target),
        );
        return {
          id: `o${orders.length}`,
          clientOrderId: null,
          symbol: req.symbol,
          type: req.type,
          side: req.side,
          price: req.price ?? null,
          amount: req.amount,
          filled: req.amount,
          remaining: 0,
          status: "closed",
          timestamp: null,
          raw: null,
        };
      }

      const filled = req.amount * fillRatio;
      adapter.positions = [
        ...adapter.positions,
        {
          symbol: req.symbol,
          side: req.side === "buy" ? "long" : "short",
          contracts: filled,
          entryPrice: req.price,
          leverage: opts.reportedLeverage ?? null,
          unrealizedPnl: 0,
        },
      ];

      return {
        id: `o${orders.length}`,
        clientOrderId: null,
        symbol: req.symbol,
        type: req.type,
        side: req.side,
        price: req.price ?? null,
        amount: req.amount,
        filled,
        remaining: req.amount - filled,
        status: "closed",
        timestamp: null,
        raw: null,
      };
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

const paper = (
  over: Partial<PaperExecutionPosition> = {},
): PaperExecutionPosition => ({
  id: "p1",
  symbol: "BTC/USD",
  direction: "long",
  quantity: 0.001,
  entryPrice: 100_000,
  notional: 100,
  ...over,
});

describe("Lighter bridge ownership", () => {
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
    const a = fakeAdapter({
      positions: [{ symbol: SYMBOL, side: "short", contracts: 0.01 }],
    });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("open is skipped when the venue has a resting order", async () => {
    const a = fakeAdapter({
      openOrders: [{ symbol: SYMBOL, side: "buy", amount: 0.01 }],
    });
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

  test("open fails closed when the balance is unavailable", async () => {
    const a = fakeAdapter({ balanceAvailable: false });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("open is refused when leverage cannot be applied", async () => {
    const a = fakeAdapter({ leverageError: true });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("connect refuses to start when leverage cannot be applied", async () => {
    const a = fakeAdapter({ leverageError: true });
    const { bridge } = await makeBridge(a);
    await expect(bridge.connect()).rejects.toThrow(/Could not set/);
  });

  test("a higher venue leverage unwinds the entry immediately", async () => {
    const a = fakeAdapter({ reportedLeverage: 25 });
    const { bridge, connection } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.orders).toHaveLength(2);
    expect(a.orders[1]).toMatchObject({ side: "sell", reduceOnly: true });
    expect(a.positions).toHaveLength(0);

    const ownership = await connection.runAndReadAll(
      "SELECT status, filled_amount, closed_amount FROM lighter_owned_positions",
    );
    expect(ownership.getRowObjects()[0]).toMatchObject({
      status: "CLOSED",
      filled_amount: 0.001,
      closed_amount: 0.001,
    });
  });

  test("notional cap rejects an oversized mirrored entry", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a, {
      LIGHTER_SIZE_MULTIPLIER: "5",
      LIGHTER_MAX_NOTIONAL_USD: "50",
    });
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("a duplicate open for the same paper position is not stacked", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onOpen(paper());
    await bridge.flush();
    expect(a.orders).toHaveLength(1);
  });
});

describe("Lighter bridge close ownership", () => {
  test("close with no venue position sends no order", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
  });

  test("close sends a reduce-only sell for a bot-owned position", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "TAKE_PROFIT");
    await bridge.flush();

    expect(a.orders).toHaveLength(2);
    expect(a.orders[1]).toMatchObject({
      side: "sell",
      amount: 0.001,
      reduceOnly: true,
    });
  });

  test("partial fills close only the filled amount", async () => {
    const a = fakeAdapter({ fillRatio: 0.5 });
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect(a.orders[1].amount).toBe(0.0005);
  });

  test("close never touches a manual position with no ownership record", async () => {
    // The user holds a manual short, paper is long, the entry is skipped, and
    // the later paper exit must not buy back the manual short.
    const a = fakeAdapter({
      positions: [{ symbol: SYMBOL, side: "short", contracts: 0.01 }],
    });
    const { bridge } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect(a.orders).toHaveLength(0);
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0].side).toBe("short");
  });

  test("close refuses when the venue position side differs from the owned side", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    // Someone replaced the bot's long with a short before the paper exit.
    a.positions = [{ symbol: SYMBOL, side: "short", contracts: 0.002 }];
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect(a.positions[0].side).toBe("short");
  });
});

describe("Lighter bridge reconcile", () => {
  test("reconcile leaves an external position untouched", async () => {
    const a = fakeAdapter({
      positions: [{ symbol: SYMBOL, side: "short", contracts: 0.002 }],
    });
    const { bridge } = await makeBridge(a);
    bridge.reconcile([]);
    await bridge.flush();
    expect(a.orders).toHaveLength(0);
    expect(a.positions).toHaveLength(1);
  });

  test("reconcile closes a bot-owned position whose paper position ended", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    bridge.reconcile([]);
    await bridge.flush();

    expect(a.orders).toHaveLength(2);
    expect(a.orders[1]).toMatchObject({ side: "sell", reduceOnly: true });
  });

  test("reconcile does not close an owned position paper still tracks", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
  });
});

describe("Lighter bridge shutdown and leverage guard", () => {
  test("clean shutdown flattens bot-owned positions", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    await bridge.close();

    expect(a.orders).toHaveLength(2);
    expect(a.orders[1]).toMatchObject({ side: "sell", reduceOnly: true });
    expect(a.closed).toBe(true);
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
