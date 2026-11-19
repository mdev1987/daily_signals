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
  /** Terminal status reported for entry orders (default "closed"). */
  entryStatus?: string;
  /** Make cancelOrder throw. */
  cancelError?: boolean;
  /** Fill the working order instead of cancelling it, simulating a race. */
  fillOnCancel?: boolean;
  /** Reported remaining quantity on the entry order (venue remainder). */
  entryRemaining?: number;
  /** Report the close order as still open with an unfilled remainder. */
  closeOpenRemainder?: boolean;
  /** Fail position reads once any order has been cancelled. */
  positionsErrorAfterCancel?: boolean;
  /** Additional size that fills on the entry side when a cancel is sent. */
  extraFillOnCancel?: number;
}

function fakeAdapter(opts: FakeOptions = {}) {
  const orders: any[] = [];
  const fillRatio = opts.fillRatio ?? 1;

  const adapter: any = {
    orders,
    cancelled: [] as string[],
    lastEntry: null as { symbol: string; side: string } | null,
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
    cancelOrder: async (orderId: string) => {
      if (opts.cancelError) throw new Error("cancel rejected");

      const order = (opts.openOrders ?? []).find(
        (candidate: any) => candidate.id === orderId,
      );
      if (opts.fillOnCancel && order) {
        const side = order.side === "buy" ? "long" : "short";
        const existing = adapter.positions.find(
          (position: any) =>
            position.symbol === order.symbol && position.side === side,
        );
        if (existing) {
          existing.contracts += order.amount;
        } else {
          adapter.positions = [
            ...adapter.positions,
            {
              symbol: order.symbol,
              side,
              contracts: order.amount,
              entryPrice: 100_000,
              leverage: opts.reportedLeverage ?? null,
              unrealizedPnl: 0,
            },
          ];
        }
      } else {
        adapter.cancelled.push(orderId);
      }

      opts.openOrders = (opts.openOrders ?? []).filter(
        (candidate: any) => candidate.id !== orderId,
      );

      // Simulate a remainder that fills while the cancel is in flight.
      if (opts.extraFillOnCancel && adapter.lastEntry) {
        const side = adapter.lastEntry.side === "buy" ? "long" : "short";
        const existing = adapter.positions.find(
          (position: any) =>
            position.symbol === adapter.lastEntry.symbol &&
            position.side === side,
        );
        if (existing) existing.contracts += opts.extraFillOnCancel;
      }
    },
    getPositions: async () => {
      if (opts.positionsErrorAfterSubmit && orders.length > 0) {
        throw new Error("position endpoint unavailable");
      }
      if (opts.positionsErrorAfterCancel && adapter.cancelled.length > 0) {
        throw new Error("position endpoint unavailable after cancel");
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
            opts.closeStatus ??
            (opts.closeOpenRemainder
              ? "open"
              : opts.closeReject
                ? "rejected"
                : "closed"),
          timestamp: null,
          raw: null,
        };
      }

      adapter.lastEntry = { symbol: req.symbol, side: req.side };
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
        remaining: opts.entryRemaining ?? req.amount - filled,
        status: opts.entryStatus ?? "closed",
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

describe("Lighter bridge pending entry orders", () => {
  test("an acknowledged entry with a working order stays PENDING", async () => {
    const a = fakeAdapter({ entryStatus: "open", fillRatio: 0 });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.orders).toHaveLength(1);
    expect(await ownershipOf(connection)).toMatchObject({
      status: "PENDING",
      confirmation: "ACKNOWLEDGED",
      filled_amount: 0,
    });

    const rows = await connection.runAndReadAll(
      "SELECT status FROM lighter_executions WHERE action = 'OPEN'",
    );
    expect(rows.getRowObjects()[0]?.status).toBe("SUBMITTED");
    expect(logs.join("\n")).toContain("still working");
  });

  test("shutdown cancels a working entry order and verifies it is gone", async () => {
    const a = fakeAdapter({ createOrderError: true, fillRatio: 0 });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.status).toBe("PENDING");

    a.options.openOrders = [
      { id: "ord-1", symbol: SYMBOL, side: "buy", amount: 0.001 },
    ];
    await bridge.close();

    expect(a.cancelled).toEqual(["ord-1"]);
    expect(a.options.openOrders).toHaveLength(0);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");

    const text = logs.join("\n");
    expect(text).toContain("cancelled before it filled");
    expect(text).toContain("shutdown flatten complete");
  });

  test("shutdown adopts and flattens a fill that landed before the cancel", async () => {
    const a = fakeAdapter({ createOrderError: true, fillRatio: 0 });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [
      { id: "ord-1", symbol: SYMBOL, side: "buy", amount: 0.001 },
    ];
    a.options.fillOnCancel = true;
    await bridge.close();

    expect(a.positions).toHaveLength(0);
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
    expect(logs.join("\n")).toContain("filled before the cancel");
    expect(logs.join("\n")).toContain("shutdown flatten complete");
  });

  test("shutdown reports a working entry order it cannot cancel", async () => {
    const a = fakeAdapter({ createOrderError: true, fillRatio: 0 });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [
      { id: "ord-1", symbol: SYMBOL, side: "buy", amount: 0.001 },
    ];
    a.options.cancelError = true;
    await bridge.close();

    expect((await ownershipOf(connection))?.status).toBe("PENDING");
    const text = logs.join("\n");
    expect(text).toContain("still has a working order");
    expect(text).toContain("pending entry");
    expect(text).toContain("shutdown left bot-owned positions open");
  });
});

describe("Lighter bridge close attribution", () => {
  test("shutdown attributes an externally closed position to external", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.positions = [];
    await bridge.close();

    const row = await ownershipOf(connection);
    expect(row?.status).toBe("CLOSED");
    expect(row?.bot_closed_amount).toBe(0);
    expect(row?.external_closed_amount).toBeCloseTo(0.001, 9);
  });

  test("closeOwned reports an already-flat venue without sending an order", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    const ordersBefore = a.orders.length;

    a.positions = [];
    const outcome = await (bridge as any).closeOwned({
      paperPositionId: "p1",
      symbol: SYMBOL,
      ownedSide: "long",
      amount: 0.001,
      reason: "test",
      action: "CLOSE",
    });

    expect(outcome.alreadyFlat).toBe(true);
    expect(outcome.filled).toBe(0);
    expect(a.orders).toHaveLength(ordersBefore);
  });

  test("legacy closed size is backfilled into an explicit column", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run(`
      CREATE TABLE lighter_owned_positions (
        paper_position_id VARCHAR PRIMARY KEY,
        symbol VARCHAR NOT NULL,
        side VARCHAR NOT NULL,
        requested_amount DOUBLE NOT NULL,
        filled_amount DOUBLE NOT NULL,
        closed_amount DOUBLE NOT NULL,
        average_price DOUBLE,
        order_id VARCHAR,
        status VARCHAR NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await connection.run(
      `INSERT INTO lighter_owned_positions VALUES
         ('legacy', ?, 'long', 0.003, 0.003, 0.002, 100000, NULL, 'CLOSED', 1, 1)`,
      [SYMBOL],
    );

    const bridge = new LighterExecutionBridge({
      connection: connection as any,
      config: loadLighterConfig(ENV),
      adapter: fakeAdapter() as unknown as LighterAdapter,
      stopLossPct: 2,
      log: () => {},
      sleep: async () => {},
    });
    await (bridge as any).ensureAuditTable();

    const rows = await connection.runAndReadAll(
      `SELECT legacy_closed_amount, bot_closed_amount, external_closed_amount
       FROM lighter_owned_positions`,
    );
    expect(rows.getRowObjects()[0]).toMatchObject({
      legacy_closed_amount: 0.002,
      bot_closed_amount: 0,
      external_closed_amount: 0,
    });
  });
});

describe("Lighter bridge order lifetime", () => {
  test("entries and closes ask for an explicit IOC market order", async () => {
    const a = fakeAdapter();
    const { bridge } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    expect(a.orders).toHaveLength(2);
    expect(a.orders[0]).toMatchObject({ type: "market", timeInForce: "IOC" });
    expect(a.orders[1]).toMatchObject({ type: "market", timeInForce: "IOC" });
  });

  test("a partial entry cancels its working remainder before claiming the fill", async () => {
    const a = fakeAdapter({
      fillRatio: 0.5,
      entryStatus: "open",
      entryRemaining: 0.0005,
    });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(a.cancelled).toEqual(["o1"]);
    expect(await ownershipOf(connection)).toMatchObject({
      status: "OPEN",
      confirmation: "CONFIRMED",
      filled_amount: 0.0005,
    });
    expect(logs.join("\n")).toContain("canceled working order o1");
  });

  test("a partial entry whose remainder cannot be cancelled stays UNRESOLVED", async () => {
    const a = fakeAdapter({
      fillRatio: 0.5,
      entryStatus: "open",
      entryRemaining: 0.0005,
      cancelError: true,
    });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect(await ownershipOf(connection)).toMatchObject({
      status: "OPEN",
      confirmation: "UNRESOLVED",
      filled_amount: 0.0005,
    });
    expect(logs.join("\n")).toContain("could not cancel working order o1");
  });

  test("a partial close cancels its remainder and records the measured fill", async () => {
    const a = fakeAdapter({ closeFillRatio: 0.5, closeOpenRemainder: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    bridge.onClose(paper(), "STOP_LOSS");
    await bridge.flush();

    const rows = await connection.runAndReadAll(
      "SELECT status FROM lighter_executions WHERE action = 'CLOSE'",
    );
    expect(rows.getRowObjects()[0]?.status).toBe("PARTIALLY_FILLED");

    const row = await ownershipOf(connection);
    expect(row?.status).toBe("OPEN");
    expect(row?.bot_closed_amount).toBeCloseTo(0.0005, 9);
    expect(a.cancelled).toContain("o2");
    expect(logs.join("\n")).toContain("canceled working order o2");
  });

  test("shutdown does not stack a second close while one is working", async () => {
    const a = fakeAdapter();
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [
      { id: "close-1", symbol: SYMBOL, side: "sell", amount: 0.001 },
    ];
    await bridge.close();

    expect(a.orders).toHaveLength(1);
    expect(a.orders.some((order: any) => order.reduceOnly)).toBe(false);
    expect((await ownershipOf(connection))?.status).toBe("OPEN");

    const text = logs.join("\n");
    expect(text).toContain("not stacking another close");
    expect(text).toContain("could not flatten BTC/USDC:USDC");
    expect(text).toContain("shutdown left bot-owned positions open");
  });

  test("adoption cancels a working entry order before claiming the position", async () => {
    const a = fakeAdapter({ createOrderError: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [
      { id: "o1", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(a.cancelled).toContain("o1");
    expect(await ownershipOf(connection)).toMatchObject({
      status: "OPEN",
      confirmation: "CONFIRMED",
    });
    expect(logs.join("\n")).toContain("adopted");
  });

  test("adoption keeps the intent PENDING when its entry order survives", async () => {
    const a = fakeAdapter({ createOrderError: true, cancelError: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    a.options.openOrders = [
      { id: "o1", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("PENDING");
    expect(logs.join("\n")).toContain("still has a working order");
  });

  test("reconcile will not close a record while its entry order can still fill", async () => {
    const a = fakeAdapter({
      fillRatio: 0.5,
      entryStatus: "open",
      entryRemaining: 0.0005,
      cancelError: true,
    });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.confirmation).toBe("UNRESOLVED");

    a.positions = [];
    a.options.openOrders = [
      { id: "o1", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    bridge.reconcile([]);
    await bridge.flush();

    expect((await ownershipOf(connection))?.status).toBe("OPEN");
    expect(logs.join("\n")).toContain("not marking it closed");
  });

  test("shutdown keeps reporting exposure when the registry read fails", async () => {
    const a = fakeAdapter({ closeError: true });
    const { bridge, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    (bridge as any).loadOwnership = async () => {
      throw new Error("registry unavailable");
    };

    await bridge.close();

    const text = logs.join("\n");
    expect(text).toContain("could not flatten BTC/USDC:USDC");
    expect(text).toContain("shutdown left bot-owned positions open");
    expect(text).not.toContain("shutdown flatten complete");
  });
});

describe("Lighter bridge post-cancel accounting", () => {
  test("an entry that grows during the cancel is recorded at the final size", async () => {
    const a = fakeAdapter({
      fillRatio: 0.5,
      entryStatus: "open",
      entryRemaining: 0.0005,
      // The cancel races a second fill of the working remainder.
      extraFillOnCancel: 0.0005,
    });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    expect((await ownershipOf(connection)) as any).toMatchObject({
      status: "OPEN",
      confirmation: "CONFIRMED",
      filled_amount: 0.001,
    });
    expect(logs.join("\n")).toContain("canceled working order o1");
  });

  test("a duplicate pending intent cancels its order before closing", async () => {
    const a = fakeAdapter();
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    await connection.run(
      `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
       VALUES ('p3', ?, 'long', 0.001, 0, 0, 0, 0, 0, 100000, 'o9', 'PENDING',
               'INTENT', 1, 1)`,
      [SYMBOL],
    );

    a.options.openOrders = [
      { id: "o9", symbol: SYMBOL, side: "buy", amount: 0.001 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(a.cancelled).toContain("o9");
    expect(a.options.openOrders).toHaveLength(0);
    expect(await ownershipOf(connection, "p3")).toMatchObject({
      status: "CLOSED",
      confirmation: "FAILED",
    });
    expect(logs.join("\n")).toContain("covered by another owned long");
  });

  test("a duplicate pending intent is kept when its order cannot be cancelled", async () => {
    const a = fakeAdapter({ cancelError: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    await connection.run(
      `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
       VALUES ('p3', ?, 'long', 0.001, 0, 0, 0, 0, 0, 100000, 'o9', 'PENDING',
               'INTENT', 1, 1)`,
      [SYMBOL],
    );

    a.options.openOrders = [
      { id: "o9", symbol: SYMBOL, side: "buy", amount: 0.001 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(await ownershipOf(connection, "p3")).toMatchObject({
      status: "PENDING",
      confirmation: "INTENT",
    });
    const text = logs.join("\n");
    expect(text).toContain("still has a working order");
    expect(text).toContain("could not cancel working order o9");
  });

  test("a duplicate fill is credited to the existing owner, then flattened", async () => {
    const a = fakeAdapter({ fillRatio: 0.5, extraFillOnCancel: 0.0005 });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.filled_amount).toBeCloseTo(0.0005, 9);

    await connection.run(
      `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
       VALUES ('p3', ?, 'long', 0.001, 0, 0, 0, 0, 0, 100000, 'o9', 'PENDING',
               'INTENT', 1, 1)`,
      [SYMBOL],
    );

    a.options.openOrders = [
      { id: "o9", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    // The cancel races a duplicate fill into the netted venue position.
    expect(a.positions[0]?.contracts).toBeCloseTo(0.001, 9);
    expect((await ownershipOf(connection))?.filled_amount).toBeCloseTo(0.001, 9);
    expect(await ownershipOf(connection, "p3")).toMatchObject({
      status: "CLOSED",
      confirmation: "FAILED",
    });
    expect(logs.join("\n")).toContain("credited 0.0005 long");

    await bridge.close();
    expect(a.positions).toHaveLength(0);
    expect(a.orders.at(-1)).toMatchObject({ amount: 0.001, reduceOnly: true });
    expect((await ownershipOf(connection))?.status).toBe("CLOSED");
  });

  test("duplicate credit keeps filled = closed + owned for a partially closed owner", async () => {
    const a = fakeAdapter();
    const { bridge, connection } = await makeBridge(a);

    await connection.run(
      `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
       VALUES ('p9', ?, 'long', 0.001, 0.0005, 0.0004, 0.0004, 0, 0, 100000,
               NULL, 'OPEN', 'CONFIRMED', 1, 1)`,
      [SYMBOL],
    );

    const owner = (await (bridge as any).listOwnership()).find(
      (row: any) => row.paperPositionId === "p9",
    );
    const added = await (bridge as any).attributeDuplicateFill(
      [owner],
      0.001,
      110_000,
    );

    expect(added).toBeCloseTo(0.0009, 9);
    const row = await ownershipOf(connection, "p9");
    expect(row?.closed_amount).toBeCloseTo(0.0004, 9);
    expect(row?.filled_amount).toBeCloseTo(0.0014, 9);
    expect((row?.filled_amount ?? 0) - (row?.closed_amount ?? 0)).toBeCloseTo(
      0.001,
      9,
    );
  });

  test("a duplicate stays PENDING when the post-cancel read fails", async () => {
    const a = fakeAdapter({ fillRatio: 0.5, positionsErrorAfterCancel: true });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();

    await connection.run(
      `INSERT INTO lighter_owned_positions
         (paper_position_id, symbol, side, requested_amount, filled_amount,
          closed_amount, bot_closed_amount, external_closed_amount,
          legacy_closed_amount, average_price, order_id, status, confirmation,
          created_at, updated_at)
       VALUES ('p3', ?, 'long', 0.001, 0, 0, 0, 0, 0, 100000, 'o9', 'PENDING',
               'INTENT', 1, 1)`,
      [SYMBOL],
    );

    a.options.openOrders = [
      { id: "o9", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    bridge.reconcile([paper()]);
    await bridge.flush();

    expect(await ownershipOf(connection, "p3")).toMatchObject({
      status: "PENDING",
      confirmation: "INTENT",
    });
    expect((await ownershipOf(connection))?.filled_amount).toBeCloseTo(0.0005, 9);
    expect(logs.join("\n")).toContain("could not be re-read after cancelling");
  });

  test("a failed post-cancel read keeps ownership UNRESOLVED", async () => {
    const a = fakeAdapter({
      fillRatio: 0.5,
      entryStatus: "open",
      entryRemaining: 0.0005,
      cancelError: true,
    });
    const { bridge, connection, logs } = await makeBridge(a);

    bridge.onOpen(paper());
    await bridge.flush();
    expect((await ownershipOf(connection))?.confirmation).toBe("UNRESOLVED");

    a.options.cancelError = false;
    a.options.openOrders = [
      { id: "o1", symbol: SYMBOL, side: "buy", amount: 0.0005 },
    ];
    a.options.positionsErrorAfterCancel = true;

    bridge.reconcile([paper()]);
    await bridge.flush();

    expect((await ownershipOf(connection))?.confirmation).toBe("UNRESOLVED");
    expect(logs.join("\n")).toContain("could not clear or re-verify");
  });
});
