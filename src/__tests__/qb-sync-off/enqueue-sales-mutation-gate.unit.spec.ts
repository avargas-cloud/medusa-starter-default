/**
 * enqueueSalesMutation (src/lib/quickbooks/pipeline/enqueue-sales-mutation.ts)
 * must skip the qb_order_pipeline write entirely when QB_SYNC_ENABLED=false —
 * no pool connection, no query, and a "skipped" mode so nothing downstream
 * mistakes a fabricated rowId for a persisted row.
 */
import { enqueueSalesMutation } from "../../lib/quickbooks/pipeline/enqueue-sales-mutation";
import { getDbPool } from "../../api/utils/db-pool";

jest.mock("../../api/utils/db-pool");

describe("enqueueSalesMutation — QB_SYNC_ENABLED=false", () => {
  const ORIGINAL = process.env.QB_SYNC_ENABLED;

  beforeEach(() => {
    process.env.QB_SYNC_ENABLED = "false";
    (getDbPool as jest.Mock).mockReturnValue({
      connect: jest.fn(async () => {
        throw new Error("getDbPool().connect() called — gate did not fire");
      }),
    });
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL;
    jest.resetAllMocks();
  });

  it("returns mode:'skipped' with a rowId, and never touches the pool", async () => {
    const result = await enqueueSalesMutation({
      step: "sales_order_mod",
      orderId: "order_01TEST",
      qbTxnId: "1CCBD1-123",
      payload: { foo: "bar" },
    });
    expect(result.mode).toBe("skipped");
    expect(typeof result.rowId).toBe("string");
    expect(result.rowId.length).toBeGreaterThan(0);
    expect(getDbPool).not.toHaveBeenCalled();
  });
});
