import { updateDraftVendorCredit } from "../update";
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
      {
        match: "FROM qb_account",
        rows: [{ qb_list_id: "80000001", full_name: "Sales:Sales Discounts", account_type: "Income" }],
      },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 2_500 }],
    });
    expect(client.calls).toContain("COMMIT");
  });

  it("resolves qb_account_full_name/qb_account_type by list id, exactly like create.ts", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      {
        match: "FROM qb_account",
        rows: [{ qb_list_id: "80000001", full_name: "Sales:Sales Discounts", account_type: "Income" }],
      },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 2_500 }],
    });
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    // params: id, credit_id, sort, line_type, variant_id, sku, mpn, description, qty,
    //         unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents
    expect(lineInsert?.params[11]).toBe("Sales:Sales Discounts");
    expect(lineInsert?.params[12]).toBe("Income");
  });

  it("rejects an inactive/unknown qb_account list id with 400 (account_not_found)", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "FROM qb_account", rows: [] }, // inactive/unknown → resolves to nothing
    ]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "qb_account", qb_account_list_id: "gone", amount_cents: 2_500 }],
      })
    ).rejects.toMatchObject({ code: "account_not_found", status: 400 });
  });

  it("rejects a qb_account line missing qb_account_list_id", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
    ]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "qb_account", amount_cents: 2_500 }],
      })
    ).rejects.toMatchObject({ code: "missing_qb_account" });
  });

  it("defaults mpn from product_variant.metadata->>'mpn' on a replaced product line", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "FROM product_variant WHERE", rows: [{ id: "variant_1", metadata: { mpn: "MPN-999" } }] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "product", variant_id: "variant_1", amount_cents: 1_000 }],
    });
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    // params: id, credit_id, sort, line_type, variant_id, sku, mpn, ...
    expect(lineInsert?.params[6]).toBe("MPN-999");
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
