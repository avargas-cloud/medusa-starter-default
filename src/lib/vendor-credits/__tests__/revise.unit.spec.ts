import { reviseVendorCredit } from "../revise";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.trim().split("\n")[0]!.trim(), params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

const HEADER = "applied_cents, stock_applied_at";
const OLD = "qb_txn_line_id\n           FROM vendor_credit_line";
const posted = (over: Record<string, unknown> = {}) => ({
  id: "vcr_1",
  number: "VC-1002",
  status: "posted",
  vendor_id: "qbv_1",
  purchase_order_id: "po_1",
  credit_date: new Date(2026, 8, 11),
  applied_cents: 0,
  stock_applied_at: new Date(2026, 8, 11),
  ...over,
});
const OLD_LINES = [
  {
    id: "vcrl_old",
    line_type: "product",
    purchase_order_line_id: "pol_1",
    qb_account_list_id: null,
    qty: 6,
    qb_txn_line_id: "1D0AFF-1",
  },
];
const PO = { id: "po_1", number: "PO-1163", status: "received", vendor_id: "qbv_1", stock_location_id: "sloc_1" };
const POL = {
  id: "pol_1",
  product_variant_id: "variant_1",
  inventory_item_id: "iitem_1",
  sku_snapshot: "SUP-MDA-300-24",
  description_snapshot: "J-Box",
  qty_received: 10,
  unit_cost_cents: 8800,
};
const line = (qty: number) => ({
  line_type: "product" as const,
  purchase_order_line_id: "pol_1",
  qty,
  unit_cost_cents: 8800,
  amount_cents: qty * 8800,
});

describe("reviseVendorCredit", () => {
  it("refuses a draft (PATCH is the draft path) and a voided credit", async () => {
    for (const status of ["draft", "voided"]) {
      const client = fakeClient([{ match: HEADER, rows: [posted({ status })] }]);
      await expect(reviseVendorCredit(client as never, "vcr_1", { memo: "x" }, "u1")).rejects.toMatchObject({
        code: "invalid_status",
        status: 409,
      });
    }
  });

  it("lowering 6→4 yields a −2 delta on the PO line, inherits the QB TxnLineID, and updates the total", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [posted()] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: OLD, rows: OLD_LINES },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [] },
      { match: "FROM product_variant WHERE", rows: [{ id: "variant_1", metadata: { mpn: "PS-300" } }] },
      { match: "SET deleted_at = now() WHERE credit_id", rows: [] },
      { match: "INSERT INTO vendor_credit_line", rows: [] },
      { match: "SET total_cents", rows: [] },
      { match: "SET revised_at", rows: [] },
    ]);
    const result = await reviseVendorCredit(client as never, "vcr_1", { lines: [line(4)] }, "u1");
    expect(result.linesChanged).toBe(true);
    expect(result.stockLocationId).toBe("sloc_1");
    expect(result.stockDeltas).toEqual([
      { purchase_order_line_id: "pol_1", inventory_item_id: "iitem_1", sku: "SUP-MDA-300-24", delta: -2 },
    ]);
    const insert = client.calls.find((c) => c.sql.includes("INSERT INTO vendor_credit_line"));
    // params: ..., amount_cents (14), qb_txn_line_id (15)
    expect(insert?.params[15]).toBe("1D0AFF-1");
    expect(insert?.params[9]).toBe(4);
    const total = client.calls.find((c) => c.sql.includes("SET total_cents"));
    expect(total?.params).toEqual(["vcr_1", 4 * 8800]);
    expect(client.calls[client.calls.length - 1]?.sql).toBe("COMMIT");
  });

  it("refuses a total below what is already applied (exceeds_applications) before touching lines", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [posted({ applied_cents: 52800 })] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: OLD, rows: OLD_LINES },
      { match: "FROM purchase_order WHERE", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [] },
    ]);
    await expect(reviseVendorCredit(client as never, "vcr_1", { lines: [line(4)] }, "u1")).rejects.toMatchObject({
      code: "exceeds_applications",
      status: 409,
    });
    expect(client.calls.some((c) => c.sql.includes("SET deleted_at = now() WHERE credit_id"))).toBe(false);
    expect(client.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("header-only revise (reason) leaves lines and stock alone", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [posted()] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "SET reason", rows: [] },
      { match: "SET revised_at", rows: [] },
    ]);
    const result = await reviseVendorCredit(client as never, "vcr_1", { reason: "RMA# 55" }, "u1");
    expect(result).toMatchObject({ linesChanged: false, stockDeltas: [], stockLocationId: null });
    expect(client.calls.some((c) => c.sql.includes("vendor_credit_line"))).toBe(false);
  });
});
