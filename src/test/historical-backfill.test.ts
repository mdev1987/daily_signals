import { describe, expect, test } from "bun:test";
import type { Candle, ExchangeAdapter } from "../exchanges/exchange.types";
import {
  backfillCandles,
  validateStoredSeries,
} from "../market-data/historical-backfill";
import { timeframeToMs } from "../market-data/timeframes";
import { openResearchDatabase } from "../storage/database";
import {
  getCursor,
  getLastCandleOpenTime,
  insertCandles,
  loadCandles,
} from "../storage/repositories/candle.repository";

const TF = timeframeToMs("5m");
const SYMBOL = "BTC/USDT:USDT";
const LAST_OPEN = 1_700_000_000_000 - (1_700_000_000_000 % TF);
const INITIAL_COUNT = 620;

function makeCandle(openTime: number): Candle {
  return {
    symbol: SYMBOL,
    timeframe: "5m",
    openTime,
    closeTime: openTime + TF,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
    turnover: null,
    isFinal: true,
  };
}

interface FakeExchange {
  adapter: ExchangeAdapter;
  requests: () => number;
  append: (count: number) => void;
  lastOpenTime: () => number;
}

function createFakeExchange(initialCount = INITIAL_COUNT): FakeExchange {
  let lastOpen = LAST_OPEN;
  let count = initialCount;
  let requests = 0;

  const dataset = () =>
    Array.from({ length: count }, (_, index) =>
      makeCandle(lastOpen - (count - 1 - index) * TF),
    );

  const adapter = {
    id: "apex",
    async getOHLCV(
      _symbol: string,
      _timeframe: string,
      _since?: number,
      limit = 200,
      until?: number,
    ): Promise<Candle[]> {
      requests++;
      const all = dataset().filter(
        (candle) => until === undefined || candle.openTime < until,
      );
      return all.slice(Math.max(0, all.length - limit));
    },
  } as unknown as ExchangeAdapter;

  return {
    adapter,
    requests: () => requests,
    append: (additional: number) => {
      lastOpen += additional * TF;
      count += additional;
    },
    lastOpenTime: () => lastOpen,
  };
}

describe("historical backfill", () => {
  test("paginates, stores only closed candles, and is idempotent", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const fake = createFakeExchange();
    const from = LAST_OPEN - (INITIAL_COUNT - 1) * TF;
    const to = LAST_OPEN + TF;

    const result = await backfillCandles(fake.adapter, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to,
      pageLimit: 200,
      requestDelayMs: 0,
    });

    expect(result.requests).toBe(4);
    expect(result.received).toBe(INITIAL_COUNT);
    expect(result.inserted).toBe(INITIAL_COUNT);
    expect(result.stopReason).toBe("complete");
    expect(await getCursor(database, "apex", SYMBOL, "5m")).toBe(
      LAST_OPEN - (INITIAL_COUNT - 1) * TF,
    );
    expect(await getLastCandleOpenTime(database, "apex", SYMBOL, "5m")).toBe(
      LAST_OPEN,
    );

    const validation = await validateStoredSeries(
      database,
      "apex",
      SYMBOL,
      "5m",
    );
    expect(validation.candles).toBe(INITIAL_COUNT);
    expect(validation.passed).toBe(true);

    // A second run resumes at the cursor and inserts nothing.
    const second = await backfillCandles(fake.adapter, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to,
      pageLimit: 200,
      requestDelayMs: 0,
    });

    expect(second.requests).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.stopReason).toBe("no-range");
  });

  test("resumes after new candles appear", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const fake = createFakeExchange(300);
    const from = LAST_OPEN - (300 - 1) * TF;

    await backfillCandles(fake.adapter, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to: LAST_OPEN + TF,
      requestDelayMs: 0,
    });

    fake.append(25);

    const result = await backfillCandles(fake.adapter, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to: fake.lastOpenTime() + TF,
      requestDelayMs: 0,
    });

    expect(result.inserted).toBe(25);
    expect(result.updated).toBe(300);
    expect(await getLastCandleOpenTime(database, "apex", SYMBOL, "5m")).toBe(
      fake.lastOpenTime(),
    );
  });

  test("does not store the still-forming candle", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const fake = createFakeExchange(10);
    const now = LAST_OPEN + TF / 2;
    const from = LAST_OPEN - (10 - 1) * TF;

    const result = await backfillCandles(fake.adapter, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to: now,
      requestDelayMs: 0,
    });

    // The candle opening at LAST_OPEN has not closed at `now`.
    expect(result.inserted).toBe(9);
    expect(await getLastCandleOpenTime(database, "apex", SYMBOL, "5m")).toBe(
      LAST_OPEN - TF,
    );
  });

  test("upgrades an in-progress candle and never downgrades a final one", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const openTime = LAST_OPEN;

    const base: Candle = {
      ...makeCandle(openTime),
      close: 100,
      isFinal: false,
    };

    const first = await insertCandles(database, "apex", [base]);
    expect(first.inserted).toBe(1);

    const finalized = await insertCandles(database, "apex", [
      { ...makeCandle(openTime), close: 105, isFinal: true },
    ]);
    expect(finalized.inserted).toBe(0);
    expect(finalized.updated).toBe(1);

    let stored = await loadCandles(
      database,
      "apex",
      SYMBOL,
      "5m",
      openTime,
      openTime,
    );
    expect(stored[0]?.isFinal).toBe(true);
    expect(stored[0]?.close).toBe(105);

    // A stale in-progress update must not overwrite the final candle.
    await insertCandles(database, "apex", [
      { ...makeCandle(openTime), close: 90, isFinal: false },
    ]);

    stored = await loadCandles(
      database,
      "apex",
      SYMBOL,
      "5m",
      openTime,
      openTime,
    );
    expect(stored[0]?.isFinal).toBe(true);
    expect(stored[0]?.close).toBe(105);
  });

  test("retries a transient page failure", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const base = createFakeExchange(5);
    let calls = 0;

    const flaky = {
      id: "apex",
      async getOHLCV(
        ...args: Parameters<ExchangeAdapter["getOHLCV"]>
      ): Promise<Candle[]> {
        calls++;
        if (calls === 1) throw new Error("request timed out");
        return base.adapter.getOHLCV(...args);
      },
    } as unknown as ExchangeAdapter;

    const from = LAST_OPEN - (5 - 1) * TF;
    const result = await backfillCandles(flaky, database, {
      symbol: SYMBOL,
      timeframe: "5m",
      from,
      to: LAST_OPEN + TF,
      requestDelayMs: 0,
    });

    expect(calls).toBe(2);
    expect(result.inserted).toBe(5);
    expect(result.stopReason).toBe("complete");
  });

  test("re-inserting finalized candles is idempotent", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const candles = [makeCandle(LAST_OPEN - TF), makeCandle(LAST_OPEN)];

    await insertCandles(database, "apex", candles);
    const second = await insertCandles(database, "apex", candles);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(
      (await loadCandles(database, "apex", SYMBOL, "5m")).length,
    ).toBe(2);
  });

  test("forward pagination tolerates sparse candles", async () => {
    const database = await openResearchDatabase({ path: ":memory:" });
    const symbol = "BTC/USD:USDC";
    const exchange = "paradex";
    const from = LAST_OPEN - (INITIAL_COUNT - 1) * TF;

    // Paradex omits intervals without trades. Skip every fifth interval so the
    // pages are short, but the walk must still cover the whole range.
    const dataset = Array.from({ length: INITIAL_COUNT }, (_, index) => ({
      ...makeCandle(from + index * TF),
      symbol,
    })).filter((_, index) => index % 5 !== 2);

    let requests = 0;

    const adapter = {
      id: exchange,
      async getOHLCV(
        _symbol: string,
        _timeframe: string,
        since?: number,
        limit = 200,
        until?: number,
      ): Promise<Candle[]> {
        requests++;
        return dataset
          .filter(
            (candle) =>
              (since === undefined || candle.openTime >= since) &&
              (until === undefined || candle.openTime < until),
          )
          .slice(0, limit);
      },
    } as unknown as ExchangeAdapter;

    const result = await backfillCandles(adapter, database, {
      symbol,
      timeframe: "5m",
      from,
      to: LAST_OPEN + TF,
      pageLimit: 200,
      requestDelayMs: 0,
      pagination: "forward",
    });

    expect(result.stopReason).toBe("complete");
    expect(result.requests).toBe(4);
    expect(result.received).toBe(dataset.length);
    expect(result.inserted).toBe(dataset.length);
    expect(requests).toBe(4);
    expect(await getLastCandleOpenTime(database, exchange, symbol, "5m")).toBe(
      LAST_OPEN,
    );

    const strict = await validateStoredSeries(
      database,
      exchange,
      symbol,
      "5m",
    );
    expect(strict.passed).toBe(false);
    expect(strict.missingIntervals).toBeGreaterThan(0);

    const sparse = await validateStoredSeries(
      database,
      exchange,
      symbol,
      "5m",
      { allowSparse: true },
    );
    expect(sparse.passed).toBe(true);
    expect(sparse.expectedSparse).toBe(true);
    expect(sparse.candles).toBe(dataset.length);
    expect(sparse.duplicates).toBe(0);
    expect(sparse.invalid).toBe(0);
    expect(sparse.nonFinalCandles).toBe(0);
  });
});
