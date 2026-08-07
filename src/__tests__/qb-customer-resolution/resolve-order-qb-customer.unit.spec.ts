/**
 * Unit tests for resolveOrderQbCustomer() — decision B1 (2026-08-06):
 * the LIVE customer's qb_list_id always wins; the order-metadata cache is a
 * fallback only, and is re-stamped whenever it disagrees with the live value.
 *
 * Type: mock-based unit test (getDbPool mocked — no DB).
 */

jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: jest.fn(),
}));

import { getDbPool } from "../../api/utils/db-pool";
import { resolveOrderQbCustomer } from "../../lib/quickbooks/resolve-order-qb-customer";

const mockGetDbPool = getDbPool as jest.MockedFunction<typeof getDbPool>;

function buildPool(selectRow?: { cached: string | null; live: string | null }) {
  const query = jest.fn(async (sql: string) => {
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: selectRow ? [selectRow] : [] };
    }
    return { rows: [], rowCount: 1 };
  });
  mockGetDbPool.mockReturnValue({ query } as unknown as ReturnType<
    typeof getDbPool
  >);
  return { query };
}

function updateCalls(query: jest.Mock) {
  return query.mock.calls.filter(([sql]) => /^\s*UPDATE/i.test(sql as string));
}

const logger = { info: jest.fn(), warn: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveOrderQbCustomer", () => {
  it("live customer wins over a stale cache and re-stamps the order metadata", async () => {
    const { query } = buildPool();
    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: "LIST-STALE",
      liveListId: "LIST-LIVE",
      logger,
    });

    expect(resolved).toBe("LIST-LIVE");
    const updates = updateCalls(query);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([
      JSON.stringify({ qb_list_id: "LIST-LIVE" }),
      "order_1",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("LIST-STALE")
    );
  });

  it("does NOT touch the DB when cache and live already agree", async () => {
    const { query } = buildPool();
    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: "LIST-A",
      liveListId: "LIST-A",
      logger,
    });

    expect(resolved).toBe("LIST-A");
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates the live value when the order has no cache yet", async () => {
    const { query } = buildPool();
    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: null,
      liveListId: "LIST-LIVE",
    });

    expect(resolved).toBe("LIST-LIVE");
    expect(updateCalls(query)).toHaveLength(1);
  });

  it("falls back to the cache when the customer has no qb_list_id", async () => {
    const { query } = buildPool();
    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: "LIST-CACHED",
      liveListId: null,
    });

    expect(resolved).toBe("LIST-CACHED");
    expect(updateCalls(query)).toHaveLength(0);
  });

  it("returns undefined when neither side has a value", async () => {
    buildPool();
    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: null,
      liveListId: null,
    });
    expect(resolved).toBeUndefined();
  });

  it("fetches both values from the DB when the caller provides neither", async () => {
    const { query } = buildPool({ cached: "LIST-STALE", live: "LIST-LIVE" });
    const resolved = await resolveOrderQbCustomer({ orderId: "order_1" });

    expect(resolved).toBe("LIST-LIVE");
    const select = query.mock.calls.find(([sql]) =>
      /^\s*SELECT/i.test(sql as string)
    );
    expect(select?.[1]).toEqual(["order_1"]);
    expect(updateCalls(query)).toHaveLength(1);
  });

  it("still returns the live value when the re-stamp write fails (best-effort)", async () => {
    const query = jest.fn(async (sql: string) => {
      if (/^\s*UPDATE/i.test(sql)) throw new Error("db down");
      return { rows: [] };
    });
    mockGetDbPool.mockReturnValue({ query } as unknown as ReturnType<
      typeof getDbPool
    >);

    const resolved = await resolveOrderQbCustomer({
      orderId: "order_1",
      cachedListId: "LIST-STALE",
      liveListId: "LIST-LIVE",
      logger,
    });

    expect(resolved).toBe("LIST-LIVE");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not re-stamp")
    );
  });
});
