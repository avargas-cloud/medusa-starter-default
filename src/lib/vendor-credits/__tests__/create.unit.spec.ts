import { createDraftVendorCredit } from "../create";
import { VendorCreditError } from "../types";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    queries,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push(sql.trim().split("\n")[0]!.trim());
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

const VENDOR = { id: "qbv_1", full_name: "ADI GLOBAL", qb_list_id: "80001976-1" };

describe("createDraftVendorCredit", () => {
  it("creates a draft with ZERO lines (POS creates the header first, edits lines via PATCH)", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "INSERT INTO vendor_credit", rows: [] },
    ]);
    const result = await createDraftVendorCredit(client as never, {
      vendor_id: "qbv_1",
      credit_date: "2026-09-11",
      reason: null,
      memo: null,
      lines: [],
      actor_id: "u1",
    });
    expect(result.id).toMatch(/^vcr/);
    expect(client.calls).toContain("BEGIN");
    expect(client.calls).toContain("COMMIT");
  });

  it("still refuses a vendor that doesn't exist", async () => {
    const client = fakeClient([{ match: "FROM qb_vendor WHERE", rows: [] }]);
    await expect(
      createDraftVendorCredit(client as never, {
        vendor_id: "qbv_missing",
        credit_date: "2026-09-11",
        reason: null,
        memo: null,
        lines: [],
        actor_id: "u1",
      })
    ).rejects.toMatchObject({ code: "vendor_not_found" });
  });

  it("still refuses a line with amount_cents <= 0", async () => {
    const client = fakeClient([{ match: "FROM qb_vendor WHERE", rows: [VENDOR] }]);
    await expect(
      createDraftVendorCredit(client as never, {
        vendor_id: "qbv_1",
        credit_date: "2026-09-11",
        reason: null,
        memo: null,
        lines: [{ line_type: "product", amount_cents: 0 }],
        actor_id: "u1",
      })
    ).rejects.toThrow(VendorCreditError);
  });

  it("defaults mpn from product_variant.metadata->>'mpn' when a product line omits it", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM product_variant WHERE", rows: [{ id: "variant_1", metadata: { mpn: "MPN-777" } }] },
      { match: "INSERT INTO vendor_credit", rows: [] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
    ]);
    await createDraftVendorCredit(client as never, {
      vendor_id: "qbv_1",
      credit_date: "2026-09-11",
      reason: null,
      memo: null,
      lines: [{ line_type: "product", variant_id: "variant_1", amount_cents: 500 }],
      actor_id: "u1",
    });
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    // params: id, credit_id, sort, line_type, variant_id, sku, mpn, description, qty, unit_cost_cents, ...
    expect(lineInsert?.params[6]).toBe("MPN-777");
  });

  it("keeps an explicit mpn instead of overwriting it from metadata", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "INSERT INTO vendor_credit", rows: [] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
    ]);
    await createDraftVendorCredit(client as never, {
      vendor_id: "qbv_1",
      credit_date: "2026-09-11",
      reason: null,
      memo: null,
      lines: [{ line_type: "product", variant_id: "variant_1", mpn: "MANUAL-MPN", amount_cents: 500 }],
      actor_id: "u1",
    });
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    expect(lineInsert?.params[6]).toBe("MANUAL-MPN");
  });
});
