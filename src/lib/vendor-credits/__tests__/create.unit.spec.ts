import { createDraftVendorCredit } from "../create";
import { VendorCreditError } from "../types";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: string[] = [];
  return {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql.trim().split("\n")[0]!.trim());
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
});
