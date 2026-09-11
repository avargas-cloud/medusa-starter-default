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

const HEADER = "SELECT id, status, vendor_id, purchase_order_id FROM vendor_credit";
const DRAFT = { id: "vcr_1", status: "draft", vendor_id: "qbv_1", purchase_order_id: null };
const DRAFT_PO = { ...DRAFT, purchase_order_id: "po_1" };
const PO = { id: "po_1", number: "PO-1001", status: "received", vendor_id: "qbv_1", stock_location_id: "sloc_1" };
const POL = {
  id: "pol_1",
  product_variant_id: "variant_1",
  inventory_item_id: "iitem_1",
  sku_snapshot: "SKU-1",
  description_snapshot: "Widget",
  qty_received: 10,
  unit_cost_cents: 1000,
};
const ACCOUNT = { qb_list_id: "80000001", full_name: "Sales:Sales Discounts", account_type: "Income" };

describe("updateDraftVendorCredit", () => {
  it("refuses replacing lines with an empty array (owner rule: the last line cannot be removed)", async () => {
    const client = fakeClient([{ match: HEADER, rows: [DRAFT] }]);
    await expect(updateDraftVendorCredit(client as never, "vcr_1", { lines: [] })).rejects.toMatchObject({
      code: "no_lines",
    });
    expect(client.calls).toContain("ROLLBACK");
    expect(client.calls.some((c) => c.includes("UPDATE vendor_credit_line SET deleted_at"))).toBe(false);
  });

  it("full-replaces account lines on a credit with no PO, resolving the account snapshot like create.ts", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "FROM qb_account", rows: [ACCOUNT] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 2_500 }],
    });
    expect(client.calls).toContain("COMMIT");
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    // params: id, credit_id, sort, line_type, variant_id, purchase_order_line_id, sku, mpn, description, qty,
    //         unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents
    expect(lineInsert?.params[5]).toBeNull();
    expect(lineInsert?.params[12]).toBe("Sales:Sales Discounts");
    expect(lineInsert?.params[13]).toBe("Income");
  });

  it("refuses a product line on a credit with no PO", async () => {
    const client = fakeClient([{ match: HEADER, rows: [DRAFT] }]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "product", variant_id: "variant_1", qty: 1, unit_cost_cents: 100, amount_cents: 100 }],
      })
    ).rejects.toMatchObject({ code: "product_line_requires_po" });
  });

  it("with a PO: the cap excludes THIS credit's own lines and persists purchase_order_line_id", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [DRAFT_PO] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [{ po_line_id: "pol_1", qty: 4 }] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "FROM product_variant WHERE", rows: [{ id: "variant_1", metadata: { mpn: "MPN-999" } }] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "UPDATE vendor_credit SET total_cents", rows: [] },
    ]);
    await updateDraftVendorCredit(client as never, "vcr_1", {
      lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 6, unit_cost_cents: 1000, amount_cents: 6000 }],
    });
    const credited = client.queries.find((q) => q.sql.includes("FROM vendor_credit_line vcl"));
    expect(credited?.params).toEqual(["po_1", "vcr_1"]);
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    expect(lineInsert?.params[5]).toBe("pol_1");
    expect(lineInsert?.params[7]).toBe("MPN-999");
    const total = client.queries.find((q) => q.sql.includes("UPDATE vendor_credit SET total_cents"));
    expect(total?.params).toEqual(["vcr_1", 6000]);
  });

  it("with a PO: refuses qty over received − other credits (exceeds_returnable) before touching lines", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [DRAFT_PO] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [{ po_line_id: "pol_1", qty: 4 }] },
    ]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 7, unit_cost_cents: 1000, amount_cents: 7000 }],
      })
    ).rejects.toMatchObject({ code: "exceeds_returnable" });
    expect(client.calls.some((c) => c.includes("UPDATE vendor_credit_line SET deleted_at"))).toBe(false);
  });

  it("vendor_bill_id: must be a confirmed regular bill of the PO; null unlinks; refused without a PO", async () => {
    const ok = fakeClient([
      { match: HEADER, rows: [DRAFT_PO] },
      { match: "FROM vendor_bill", rows: [{ id: "vb_1", number: "VB-1", status: "confirmed", reference_id: null }] },
      { match: "UPDATE vendor_credit SET vendor_bill_id", rows: [] },
    ]);
    await updateDraftVendorCredit(ok as never, "vcr_1", { vendor_bill_id: "vb_1" });
    expect(ok.calls).toContain("COMMIT");

    const wrong = fakeClient([
      { match: HEADER, rows: [DRAFT_PO] },
      { match: "FROM vendor_bill", rows: [{ id: "vb_1", number: "VB-1", status: "confirmed", reference_id: null }] },
    ]);
    await expect(updateDraftVendorCredit(wrong as never, "vcr_1", { vendor_bill_id: "vb_2" })).rejects.toMatchObject({
      code: "bill_not_on_po",
    });

    const unlink = fakeClient([
      { match: HEADER, rows: [DRAFT_PO] },
      { match: "UPDATE vendor_credit SET vendor_bill_id", rows: [] },
    ]);
    await updateDraftVendorCredit(unlink as never, "vcr_1", { vendor_bill_id: null });
    expect(unlink.queries.find((q) => q.sql.includes("SET vendor_bill_id"))?.params).toEqual(["vcr_1", null]);

    const noPo = fakeClient([{ match: HEADER, rows: [DRAFT] }]);
    await expect(updateDraftVendorCredit(noPo as never, "vcr_1", { vendor_bill_id: "vb_1" })).rejects.toMatchObject({
      code: "bill_requires_po",
    });
  });

  it("rejects an inactive/unknown qb_account list id with 400 (account_not_found)", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [DRAFT] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "FROM qb_account", rows: [] },
    ]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "qb_account", qb_account_list_id: "gone", amount_cents: 2_500 }],
      })
    ).rejects.toMatchObject({ code: "account_not_found", status: 400 });
  });

  it("rejects a qb_account line missing qb_account_list_id", async () => {
    const client = fakeClient([{ match: HEADER, rows: [DRAFT] }]);
    await expect(
      updateDraftVendorCredit(client as never, "vcr_1", {
        lines: [{ line_type: "qb_account", amount_cents: 2_500 }],
      })
    ).rejects.toMatchObject({ code: "missing_qb_account" });
  });

  it("refuses when the credit is not draft", async () => {
    const client = fakeClient([{ match: HEADER, rows: [{ ...DRAFT, status: "posted" }] }]);
    await expect(updateDraftVendorCredit(client as never, "vcr_1", { memo: "x" })).rejects.toThrow(
      VendorCreditError
    );
  });
});
