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
const ACCOUNT = { qb_list_id: "80000001", full_name: "Purchases:Returns", account_type: "Expense" };
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

const base = { vendor_id: "qbv_1", credit_date: "2026-09-11", reason: null, memo: null, actor_id: "u1" };

describe("createDraftVendorCredit", () => {
  it("refuses ZERO lines (owner rule 2026-09-11: an empty credit is never saved)", async () => {
    const client = fakeClient([]);
    await expect(createDraftVendorCredit(client as never, { ...base, lines: [] })).rejects.toMatchObject({
      code: "no_lines",
    });
    expect(client.calls).not.toContain("BEGIN");
  });

  it("creates an account-only draft with no PO and assigns VC-#### at create", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM qb_account", rows: [ACCOUNT] },
      { match: "'VC-' || nextval", rows: [{ number: "VC-1001" }] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "INSERT INTO vendor_credit", rows: [] },
    ]);
    const result = await createDraftVendorCredit(client as never, {
      ...base,
      lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 500 }],
    });
    expect(result.id).toMatch(/^vcr/);
    expect(result.number).toBe("VC-1001");
    expect(client.calls).toContain("COMMIT");
    const header = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit\n"));
    // params: id, number, vendor_id, name, qb_list_id, purchase_order_id, vendor_bill_id, ...
    expect(header?.params[5]).toBeNull();
    expect(header?.params[6]).toBeNull();
  });

  it("refuses a product line when the credit has no PO (product_line_requires_po)", async () => {
    const client = fakeClient([{ match: "FROM qb_vendor WHERE", rows: [VENDOR] }]);
    await expect(
      createDraftVendorCredit(client as never, {
        ...base,
        lines: [{ line_type: "product", variant_id: "variant_1", qty: 1, unit_cost_cents: 500, amount_cents: 500 }],
      })
    ).rejects.toMatchObject({ code: "product_line_requires_po" });
  });

  it("refuses a related bill without a PO (bill_requires_po)", async () => {
    const client = fakeClient([{ match: "FROM qb_vendor WHERE", rows: [VENDOR] }]);
    await expect(
      createDraftVendorCredit(client as never, {
        ...base,
        vendor_bill_id: "vb_1",
        lines: [{ line_type: "qb_account", qb_account_list_id: "80000001", amount_cents: 500 }],
      })
    ).rejects.toMatchObject({ code: "bill_requires_po" });
  });

  it("with a PO: persists purchase_order_id + purchase_order_line_id and caps qty at received − credited", async () => {
    const handlers = [
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [{ po_line_id: "pol_1", qty: 7 }] },
      { match: "FROM vendor_bill", rows: [{ id: "vb_1", number: "VB-1", status: "confirmed", reference_id: null }] },
      { match: "FROM product_variant WHERE", rows: [{ id: "variant_1", metadata: { mpn: "MPN-1" } }] },
      { match: "'VC-' || nextval", rows: [{ number: "VC-1002" }] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "INSERT INTO vendor_credit", rows: [] },
    ];
    const ok = fakeClient(handlers);
    await createDraftVendorCredit(ok as never, {
      ...base,
      purchase_order_id: "po_1",
      vendor_bill_id: "vb_1",
      lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 3, unit_cost_cents: 1000, amount_cents: 3000 }],
    });
    const header = ok.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit\n"));
    expect(header?.params[5]).toBe("po_1");
    expect(header?.params[6]).toBe("vb_1");
    const line = ok.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    // params: id, credit_id, sort, line_type, variant_id, purchase_order_line_id, sku, mpn, description, qty, ...
    expect(line?.params[4]).toBe("variant_1");
    expect(line?.params[5]).toBe("pol_1");
    expect(line?.params[6]).toBe("SKU-1");
    expect(line?.params[7]).toBe("MPN-1");
    expect(line?.params[8]).toBe("Widget");

    const tooMany = fakeClient(handlers);
    await expect(
      createDraftVendorCredit(tooMany as never, {
        ...base,
        purchase_order_id: "po_1",
        lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 4, unit_cost_cents: 1000, amount_cents: 4000 }],
      })
    ).rejects.toMatchObject({ code: "exceeds_returnable" });
    expect(tooMany.calls).not.toContain("BEGIN");
  });

  it("refuses a PO of another vendor and a PO with nothing received", async () => {
    const otherVendor = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM purchase_order WHERE", rows: [{ ...PO, vendor_id: "qbv_other" }] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
    ]);
    await expect(
      createDraftVendorCredit(otherVendor as never, {
        ...base,
        purchase_order_id: "po_1",
        lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 1, unit_cost_cents: 1, amount_cents: 1 }],
      })
    ).rejects.toMatchObject({ code: "po_vendor_mismatch" });

    const nothing = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [{ ...POL, qty_received: 0 }] },
    ]);
    await expect(
      createDraftVendorCredit(nothing as never, {
        ...base,
        purchase_order_id: "po_1",
        lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 1, unit_cost_cents: 1, amount_cents: 1 }],
      })
    ).rejects.toMatchObject({ code: "po_nothing_received" });
  });

  it("refuses a related bill that is not a confirmed regular bill of the PO (bill_not_on_po)", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [] },
      { match: "FROM vendor_bill", rows: [] },
    ]);
    await expect(
      createDraftVendorCredit(client as never, {
        ...base,
        purchase_order_id: "po_1",
        vendor_bill_id: "vb_elsewhere",
        lines: [{ line_type: "product", purchase_order_line_id: "pol_1", qty: 1, unit_cost_cents: 1, amount_cents: 1 }],
      })
    ).rejects.toMatchObject({ code: "bill_not_on_po" });
  });

  it("still refuses a vendor that doesn't exist and a line with amount_cents <= 0", async () => {
    const missing = fakeClient([{ match: "FROM qb_vendor WHERE", rows: [] }]);
    await expect(
      createDraftVendorCredit(missing as never, {
        ...base,
        vendor_id: "qbv_missing",
        lines: [{ line_type: "qb_account", qb_account_list_id: "8", amount_cents: 1 }],
      })
    ).rejects.toMatchObject({ code: "vendor_not_found" });

    const zero = fakeClient([]);
    await expect(
      createDraftVendorCredit(zero as never, {
        ...base,
        lines: [{ line_type: "qb_account", qb_account_list_id: "8", amount_cents: 0 }],
      })
    ).rejects.toThrow(VendorCreditError);
  });

  it("keeps an explicit mpn instead of overwriting it from metadata", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [] },
      { match: "'VC-' || nextval", rows: [{ number: "VC-1003" }] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "INSERT INTO vendor_credit", rows: [] },
    ]);
    await createDraftVendorCredit(client as never, {
      ...base,
      purchase_order_id: "po_1",
      lines: [{ line_type: "product", purchase_order_line_id: "pol_1", mpn: "MANUAL-MPN", qty: 1, unit_cost_cents: 500, amount_cents: 500 }],
    });
    const lineInsert = client.queries.find((q) => q.sql.includes("INSERT INTO vendor_credit_line"));
    expect(lineInsert?.params[7]).toBe("MANUAL-MPN");
    // No metadata lookup when every product line already carries an mpn.
    expect(client.queries.some((q) => q.sql.includes("FROM product_variant WHERE"))).toBe(false);
  });
});
