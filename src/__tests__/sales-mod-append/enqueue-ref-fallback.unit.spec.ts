/**
 * medusa_ref_number fallback on the append-only INSERT (2026-08-11).
 *
 * A writePipelineRow intent:"mod" redirect that doesn't thread medusaRefNumber
 * used to insert mod rows with a blank REF column (prod rows 8224/8225). The
 * INSERT now derives E/S + display_id from "order" for the two order-scoped
 * steps. The fake pool here can't validate the SQL against Postgres (that's
 * /sql-bindcheck + the sandbox E2E) — what this spec pins is that the INSERT
 * statement still CARRIES the fallback and that a caller-provided ref still
 * travels as $9, so a revert of either fails loudly.
 */
import { enqueueSalesMutation } from "../../lib/quickbooks/pipeline/enqueue-sales-mutation";
import { getDbPool } from "../../api/utils/db-pool";

jest.mock("../../api/utils/db-pool");

type QueryCall = { sql: string; params: unknown[] };

function mockPoolCapturing(calls: QueryCall[]) {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (/SELECT id, status, payload/.test(sql)) return { rows: [] };
      if (/INSERT INTO qb_order_pipeline/.test(sql))
        return { rows: [{ id: "row-uuid-1" }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  (getDbPool as jest.Mock).mockReturnValue({
    connect: async () => client,
  });
  return client;
}

describe("enqueueSalesMutation medusa_ref_number fallback", () => {
  afterEach(() => jest.resetAllMocks());

  async function runInsert(medusaRefNumber: string | null) {
    const calls: QueryCall[] = [];
    mockPoolCapturing(calls);
    const result = await enqueueSalesMutation({
      step: "sales_order_mod",
      orderId: "order_01TEST",
      qbTxnId: "1CCBD1-123",
      payload: {},
      medusaRefNumber,
    });
    const insert = calls.find((c) =>
      /INSERT INTO qb_order_pipeline/.test(c.sql)
    );
    return { result, insert };
  }

  it("the INSERT derives E/S + display_id from \"order\" when no ref is passed", async () => {
    const { result, insert } = await runInsert(null);
    expect(result.mode).toBe("inserted");
    expect(insert).toBeDefined();
    const sql = insert!.sql;
    // The fallback names exactly the two order-scoped steps…
    expect(sql).toContain("'estimate_mod'");
    expect(sql).toContain("'sales_order_mod'");
    // …reads the order's display_id…
    expect(sql).toMatch(/FROM "order"/);
    expect(sql).toMatch(/display_id/);
    // …and only kicks in when the caller passed nothing ($9 wrapped in COALESCE).
    expect(sql).toMatch(/COALESCE\(\s*\$9/);
    expect(insert!.params[8]).toBeNull();
  });

  it("a caller-provided ref still travels as the $9 binding (COALESCE keeps it)", async () => {
    const { insert } = await runInsert("S3021");
    expect(insert!.params[8]).toBe("S3021");
  });
});
