import { updateDraftVendorCredit } from "../update";
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

const DRAFT = { id: "vcr_1", status: "draft" };

describe("updateDraftVendorCredit", () => {
  it("allows replacing lines with an empty array (clears them, total_cents = 0)", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", { lines: [] });
    expect(client.calls).toContain("COMMIT");
  });

  it("full-replaces lines when a non-empty array is given", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 2_500 }],
    });
    expect(client.calls).toContain("COMMIT");
  });

  it("refuses when the credit is not draft", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [{ id: "vcr_1", status: "posted" }] },
    ]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", { memo: "x" })
    ).rejects.toThrow(VendorCreditError);
  });
});
