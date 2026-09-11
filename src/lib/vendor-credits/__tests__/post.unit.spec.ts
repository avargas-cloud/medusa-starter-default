import { markVendorCreditPosted } from "../post";
import { VendorCreditError } from "../types";

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

const HEADER = "number, purchase_order_id, credit_date, total_cents FROM vendor_credit";
const LINES = "FROM vendor_credit_line WHERE credit_id";
const row = (over: Record<string, unknown> = {}) => ({
  id: "vcr_1",
  status: "draft",
  number: "VC-1001",
  purchase_order_id: null,
  credit_date: new Date(2026, 8, 11),
  total_cents: 5_000,
  ...over,
});
const ACCOUNT_LINE = { line_type: "qb_account", variant_id: null, purchase_order_line_id: null, sku: null, qty: null, amount_cents: "5000" };
const PRODUCT_LINE = { line_type: "product", variant_id: "variant_1", purchase_order_line_id: "pol_1", sku: "SKU-1", qty: 3, amount_cents: "3000" };
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

describe("markVendorCreditPosted", () => {
  it("refuses a draft with zero lines (no_lines)", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [row({ total_cents: 0 })] },
      { match: LINES, rows: [] },
    ]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "no_lines",
    });
  });

  it("converts a pg Date credit_date to an ISO string before the period-lock check", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [row()] },
      { match: LINES, rows: [ACCOUNT_LINE] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_credit SET status='posted'", rows: [] },
    ]);
    const result = await markVendorCreditPosted(client as never, "vcr_1", "u1");
    // The number is the one already on the row (assigned at create) —
    // `post` never calls `nextVendorCreditNumber` again.
    expect(result.number).toBe("VC-1001");

    const periodCheckCall = client.calls.find((c) => c.sql.includes("accounting_period_close"));
    expect(periodCheckCall?.params).toEqual(["2026-09-11"]);
  });

  it("with a PO: locks the PO row and re-asserts the cap against OTHER credits (race gate)", async () => {
    const handlers = (creditedByOthers: number) => [
      { match: HEADER, rows: [row({ purchase_order_id: "po_1", total_cents: 3000 })] },
      { match: LINES, rows: [PRODUCT_LINE] },
      { match: "FROM purchase_order WHERE id = $1 FOR UPDATE", rows: [{ id: "po_1" }] },
      { match: "FROM purchase_order WHERE id = $1 AND deleted_at", rows: [PO] },
      { match: "FROM purchase_order_line WHERE", rows: [POL] },
      { match: "FROM vendor_credit_line vcl", rows: [{ po_line_id: "pol_1", qty: creditedByOthers }] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_credit SET status='posted'", rows: [] },
    ];
    const ok = fakeClient(handlers(7));
    await expect(markVendorCreditPosted(ok as never, "vcr_1", "u1")).resolves.toMatchObject({ number: "VC-1001" });
    expect(ok.calls.some((c) => c.sql.includes("FOR UPDATE") && c.sql.includes("purchase_order"))).toBe(true);
    // `calls` keeps only the FIRST line of each SQL — the credited-qty query's
    // first line is its SELECT list, the FROM lives on line 2.
    const credited = ok.calls.find((c) => c.sql.includes("vcl.purchase_order_line_id AS po_line_id"));
    expect(credited?.params).toEqual(["po_1", "vcr_1"]);

    // Another credit posted 8 in between → 8 + 3 > 10 received → refused, no status flip.
    const raced = fakeClient(handlers(8));
    await expect(markVendorCreditPosted(raced as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "exceeds_returnable",
    });
    expect(raced.calls.some((c) => c.sql.includes("SET status='posted'"))).toBe(false);
    expect(raced.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("refuses to post product lines on a credit with no PO (legacy row)", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [row({ total_cents: 3000 })] },
      { match: LINES, rows: [PRODUCT_LINE] },
    ]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "product_line_requires_po",
    });
  });

  it("refuses a non-draft credit", async () => {
    const client = fakeClient([{ match: HEADER, rows: [row({ status: "posted" })] }]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toThrow(VendorCreditError);
  });

  it("refuses a draft somehow missing its number (should be unreachable — create.ts always assigns one)", async () => {
    const client = fakeClient([
      { match: HEADER, rows: [row({ number: null })] },
      { match: LINES, rows: [ACCOUNT_LINE] },
      { match: "FROM accounting_period_close", rows: [] },
    ]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "missing_number",
    });
  });
});
