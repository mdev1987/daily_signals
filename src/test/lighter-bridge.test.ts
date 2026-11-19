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
  /** Fraction of a reduce-only close that fills (default 1). */
  closeFillRatio?: number;
  /** Make reduce-only orders throw, as a rejected signing request would. */
  closeError?: boolean;
  /** Return a rejected order without closing anything. */
  closeReject?: boolean;
  /** Status to report on a reduce-only order (e.g. "canceled"). */
  closeStatus?: string;
  /** Make close orders for one symbol only throw. */
  closeErrorSymbol?: string;
  /** Make the position endpoint throw after the entry order was submitted. */
  positionsErrorAfterSubmit?: boolean;
  /** Add the venue position, then throw as if the acknowledgement was lost. */
  createOrderError?: boolean;
  /** Hook used to inspect state at the moment the order is submitted. */
  beforeOrder?: () => Promise<void>;
}

function fakeAdapter(opts: FakeOptions = {}) {
  const orders: any[] = [];
  const fillRatio = opts.fillRatio ?? 1;

  const adapter: any = {
    orders,
    options: opts,
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
      {
        symbol: "ETH/USDC:USDC",
        amountStep: 0.0001,
        minAmount: 0.0002,
        minCost: 10,
      },
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
    getPositions: async () => {
      if (opts.positionsErrorAfterSubmit && orders.length > 0) {
        throw new Error("position endpoint unavailable");
      }
      return adapter.positions;
    },
    setLeverage: async () => {
      if (opts.leverageError) throw new Error("leverage rejected");
    },
    createOrder: async (req: any) => {
      if (opts.beforeOrder) await opts.beforeOrder();
      orders.push(req);

      if (req.reduceOnly) {
        if (
          opts.closeError ||
          (opts.closeErrorSymbol !== undefined &&
            req.symbol === opts.closeErrorSymbol)
        ) {
          throw new Error("close order rejected");
        }

        const target = req.side === "sell" ? "long" : "short";
        const ratio = opts.closeReject ? 0 : (opts.closeFillRatio ?? 1);
        let filled = 0;

        adapter.positions = adapter.positions
          .map((position: any) => {
            if (position.symbol !== req.symbol || position.side !== target) {
              return position;
            }
            const closed = Math.min(
              Math.abs(position.contracts),
              req.amount * ratio,
            );
            filled += closed;
            return {
              ...position,
              contracts: Math.abs(position.contracts) - closed,
            };
          })
          .filter((position: any) => Math.abs(position.contracts) > 0);

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
          status:
            opts.closeStatus ?? (opts.closeReject ? "rejected" : "closed"),
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

      // The order can be accepted by the venue while the response is lost.
      if (opts.createOrderError) {
        throw new Error("order acknowledgement lost");
      }

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
  const logs: string[] = [];
  const bridge = new LighterExecutionBridge({
    connection: connection as any,
    config: loadLighterConfig({ ...ENV, ...env }),
    adapter: adapter as LighterAdapter,
    stopLossPct: 2,
    log: (message) => logs.push(message),
    sleep: async () => {},
  });
  await (bridge as any).ensureAuditTable();
  return { bridge, connection, logs };
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
    const { bridge } = await makeBridge(a, {
      LIGHTER_SIZE_MULTIPLIER: "5",
      LIGHTER_MAX_NOTIONAL_USD: "1000",
    });
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

  test("reconcile closes an owned record that is flat beside an unrelated position", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);
    bridge.onOpen(paper());
    await bridge.flush();

    // The bot's long is gone; a manual short is now the only venue position.
    a.positions = [{ symbol: SYMBOL, side: "short", contracts: 0.002 }];
    bridge.reconcile([]);
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0].side).toBe("short");
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
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

async function ownershipOf(connection: any, id = "p1") {
  const result = await connection.runAndReadAll(
    `SELECT status, confirmation, filled_amount, closed_amount,
            bot_closed_amount, external_closed_amount
     FROM lighter_owned_positions WHERE paper_position_id = ?`,
    [id],
  );
  return result.getRowObjects()[0] as
    | {
        status: string;
        confirmation: string;
        filled_amount: number;
        closed_amount: number;
        bot_closed_amount: number;
        external_closed_amount: number;
      }
    | undefined;
}

describe("Lighter bridge failure handling", () => {
  test("an unwind that finds no price keeps ownership pending", async () => {
    const a = fakeAdapter({ reportedLeverage: 25 });
    const { bridge, connection } = await makeBridge(a);

    // The entry has a price; the unwind does not. This is the state a halted
    // or one-sided book leaves the bridge in after a fill.
    const realWorst = (bridge as any).worstPrice.bind(bridge);
    (bridge as any).worstPrice = async (
      symbol: string,
      side: "buy" | "sell",
    ) => (side === "sell" ? null : realWorst(symbol, side));

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.positions).toHaveLength(1);
    expect((await ownershipOf(connection))?.status).toBe("UNWIND_PENDING");
  });

  test("a rejected unwind keeps ownership pending for reconcile", async () => {
    const a = fakeAdapter({ reportedLeverage: 25, closeError: true });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(await ownershipOf(connection)).toMatchObject({
      status: "UNWIND_PENDING",
      filled_amount: 0.001,
      closed_amount: 0,
    });
  });

  test("a partially filled unwind advances ownership and stays pending", async () => {
    const a = fakeAdapter({ reportedLeverage: 25, closeFillRatio: 0.25 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    // Two attempts each fill a quarter of what is left; the row must not be
    // reported as closed while the venue still holds contracts.
    const row = await ownershipOf(connection);
    expect(row?.status).toBe("UNWIND_PENDING");
    expect(row?.filled_amount).toBe(0.001);
    expect(row?.closed_amount).toBeCloseTo(0.0004375, 9);
    expect(a.positions).toHaveLength(1);

    a.options.closeFillRatio = 1;
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(a.positions).toHaveLength(0);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
  });

  test("reconcile finishes a pending unwind even while paper is open", async () => {
    const a = fakeAdapter({ reportedLeverage: 25, closeFillRatio: 0 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.status).toBe("UNWIND_PENDING");

    a.options.closeFillRatio = 1;
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(a.positions).toHaveLength(0);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
  });

  test("a partial close advances ownership by the actual fill", async () => {
    const a = fakeAdapter({ closeFillRatio: 0.5 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect(await ownershipOf(connection)).toMatchObject({
      status: "OPEN",
      filled_amount: 0.001,
      closed_amount: 0.0005,
    });

    // Reconcile sees paper closed and closes the remainder.
    a.options.closeFillRatio = 1;
    bridge.reconcile([]);
    await bridge.flush();

    expect(a.positions).toHaveLength(0);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
  });

  test("a zero-fill close is recorded as UNKNOWN and keeps ownership", async () => {
    const a = fakeAdapter({ closeFillRatio: 0 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("OPEN");

    const executions = await connection.runAndReadAll(
      "SELECT status, filled_amount FROM lighter_executions WHERE action = 'CLOSE'",
    );
    expect(executions.getRowObjects()[0]).toMatchObject({
      status: "UNKNOWN",
      filled_amount: 0,
    });
  });

  test("a rejected close is recorded as REJECTED and returns no fill", async () => {
    const a = fakeAdapter({ closeReject: true });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("OPEN");
    const executions = await connection.runAndReadAll(
      "SELECT status, filled_amount FROM lighter_executions WHERE action = 'CLOSE'",
    );
    expect(executions.getRowObjects()[0]).toMatchObject({
      status: "REJECTED",
      filled_amount: 0,
    });
  });

  test("shutdown retries, then reports the residual position", async () => {
    const a = fakeAdapter({ closeFillRatio: 0 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    await bridge.close();

    // One entry plus three flatten attempts.
    expect(a.orders).toHaveLength(4);
    expect(a.positions).toHaveLength(1);
    expect((await ownershipOf(connection))?.status).toBe("OPEN");
    expect(a.closed).toBe(true);
  });

  test("missing venue leverage is reported but does not unwind", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect((await ownershipOf(connection))?.status).toBe("OPEN");
  });
});

const ethPaper = (): PaperExecutionPosition =>
  paper({
    id: "p2",
    symbol: "ETH/USD",
    entryPrice: 3_000,
    quantity: 0.01,
    notional: 30,
  });

describe("Lighter bridge durable entry intent", () => {
  test("the intent is durable before the order leaves the process", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);

    let atSubmission: any = null;
    a.options.beforeOrder = async () => {
      atSubmission = await ownershipOf(connection);
    };

    bridge.onOpen(paper());
    await bridge.flush();

    expect(atSubmission).toMatchObject({
      status: "PENDING",
      confirmation: "INTENT",
      filled_amount: 0,
    });
    expect(await ownershipOf(connection)).toMatchObject({
      status: "OPEN",
      confirmation: "CONFIRMED",
    });
  });

  test("an unverifiable entry keeps a PENDING row that reconcile adopts", async () => {
    const a = fakeAdapter({ positionsErrorAfterSubmit: true });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect(await ownershipOf(connection)).toMatchObject({
      status: "PENDING",
      confirmation: "UNRESOLVED",
      filled_amount: 0,
    });

    // The endpoint recovers; reconcile adopts the fill from the venue.
    a.options.positionsErrorAfterSubmit = false;
    bridge.reconcile([paper()]);
    await bridge.flush();

    const row = await ownershipOf(connection);
    expect(row?.status).toBe("OPEN");
    expect(row?.confirmation).toBe("CONFIRMED");
    expect(row?.filled_amount).toBeCloseTo(0.001, 9);
    expect(a.orders).toHaveLength(1);
  });

  test("a lost acknowledgement is adopted from the venue", async () => {
    const a = fakeAdapter({ createOrderError: true });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.positions).toHaveLength(1);
    expect(await ownershipOf(connection)).toMatchObject({
      status: "PENDING",
      confirmation: "UNRESOLVED",
    });

    bridge.reconcile([paper()]);
    await bridge.flush();

    const row = await ownershipOf(connection);
    expect(row?.status).toBe("OPEN");
    expect(row?.filled_amount).toBeCloseTo(0.001, 9);
  });

  test("reconcile closes an intent the venue never filled", async () => {
    const a = fakeAdapter({ createOrderError: true, fillRatio: 0 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.status).toBe("PENDING");

    bridge.reconcile([]);
    await bridge.flush();

    expect(await ownershipOf(connection)).toMatchObject({
      status: "CLOSED",
      confirmation: "FAILED",
      filled_amount: 0,
      closed_amount: 0,
    });
  });

  test("reconcile leaves a pending intent alone while an order works", async () => {
    const a = fakeAdapter({ createOrderError: true, fillRatio: 0 });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [{ symbol: SYMBOL, side: "buy", amount: 0.001 }];
    bridge.reconcile([]);
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("PENDING");
    expect(a.orders).toHaveLength(1);
  });
});

describe("Lighter bridge failure attribution", () => {
  test("a canceled close with a partial fill is PARTIALLY_FILLED", async () => {
    const a = fakeAdapter({ closeFillRatio: 0.5, closeStatus: "canceled" });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    const rows = await connection.runAndReadAll(
      "SELECT status, filled_amount FROM lighter_executions WHERE action = 'CLOSE'",
    );
    expect(rows.getRowObjects()[0]?.status).toBe("PARTIALLY_FILLED");

    const row = await ownershipOf(connection);
    expect(row?.status).toBe("OPEN");
    expect(row?.bot_closed_amount).toBeCloseTo(0.0005, 9);
    expect(row?.external_closed_amount).toBe(0);
  });

  test("a position closed outside the bot is attributed as external", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.positions = [];
    bridge.reconcile([]);
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect(await ownershipOf(connection)).toMatchObject({
      status: "CLOSED",
      bot_closed_amount: 0,
    });
    expect((await ownershipOf(connection))?.external_closed_amount).toBeCloseTo(
      0.001,
      9,
    );
  });

  test("a thrown unwind logs the unresolved leverage alert", async () => {
    const a = fakeAdapter({ reportedLeverage: 25, closeError: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("UNWIND_PENDING");
    expect(logs.join("\n")).toContain("leverage mismatch is UNRESOLVED");
  });

  test("shutdown adopts and closes a pending entry that filled", async () => {
    const a = fakeAdapter({ positionsErrorAfterSubmit: true });
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.status).toBe("PENDING");

    // The endpoint recovers only at shutdown time.
    a.options.positionsErrorAfterSubmit = false;
    await bridge.close();

    expect(a.positions).toHaveLength(0);
    expect(a.orders).toHaveLength(2);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
  });

  test("shutdown reports a pending entry it cannot resolve", async () => {
    const a = fakeAdapter({ positionsErrorAfterSubmit: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    await bridge.close();

    expect((await ownershipOf(connection))?.status).toBe("PENDING");
    const text = logs.join("\n");
    expect(text).toContain("could not resolve pending intent");
    expect(text).toContain("pending entry");
    expect(text).toContain("shutdown left bot-owned positions open");
  });

  test("shutdown keeps flattening other positions when one close throws", async () => {
    const a = fakeAdapter({ closeErrorSymbol: SYMBOL });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onOpen(ethPaper());
    await bridge.flush();

    await bridge.close();

    // BTC: one entry plus three failed close attempts. ETH: entry plus close.
    expect(a.orders).toHaveLength(6);
    expect(
      a.positions.filter((position: any) => position.symbol === SYMBOL),
    ).toHaveLength(1);
    expect(
      a.positions.filter(
        (position: any) => position.symbol === "ETH/USDC:USDC",
      ),
    ).toHaveLength(0);
    expect(a.closed).toBe(true);

    expect((await ownershipOf(connection, "p1"))?.status).toBe("OPEN");
    expect((await ownershipOf(connection, "p2"))?.status).toBe("CLOSED");

    const text = logs.join("\n");
    expect(text).toContain("attempt 1/3 failed");
    expect(text).toContain("could not flatten BTC/USDC:USDC");
    expect(text).toContain("shutdown left bot-owned positions open");
  });
});
