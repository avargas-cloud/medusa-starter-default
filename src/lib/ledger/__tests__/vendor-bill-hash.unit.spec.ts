import { computeVendorBillSourceHash } from "../documents/vendor-bill";

/**
 * §5/§6: "hash-includes-classification" — el snapshot NUNCA es sólo el
 * header. Un mismo header con la MISMA revisión activa pero una línea que
 * cambió de "gasto del período" a "capitalizada" (o cuyo `landed_total_cents`
 * cambió) tiene que producir un hash DISTINTO, o el drift del reconciler
 * nunca lo detectaría.
 */
describe("computeVendorBillSourceHash", () => {
  const header = {
    id: "vb_1",
    number: "VB-1001",
    status: "confirmed",
    bill_type: "regular",
    qb_amount_due_cents: null,
    document_date: "2026-09-01",
    confirmed_at: "2026-09-01T00:00:00Z",
    active_revision_id: "vbr_1",
  };
  const baseLine = {
    id: "vbl_1",
    line_type: "qb_account",
    qb_account_list_id: "acct-1",
    landed_total_cents: 1000,
    line_cents: "1000",
    in_scope: true,
  };

  it("changes when a line's classification (in_scope) flips", () => {
    const a = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [] });
    const b = computeVendorBillSourceHash({
      header,
      lineRows: [{ ...baseLine, in_scope: false }],
      receipts: [],
    });
    expect(a).not.toBe(b);
  });

  it("changes when a line's landed_total_cents changes", () => {
    const a = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [] });
    const b = computeVendorBillSourceHash({
      header,
      lineRows: [{ ...baseLine, landed_total_cents: 1200 }],
      receipts: [],
    });
    expect(a).not.toBe(b);
  });

  it("changes when the active revision changes", () => {
    const a = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [] });
    const b = computeVendorBillSourceHash({
      header: { ...header, active_revision_id: "vbr_2" },
      lineRows: [baseLine],
      receipts: [],
    });
    expect(a).not.toBe(b);
  });

  it("changes when a bound receipt's cost changes", () => {
    const receipt = { id: "por_1", qty_received_now: 10, unit_cost_cents_override: null, po_line_unit_cost_cents: 500 };
    const a = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [receipt] });
    const b = computeVendorBillSourceHash({
      header,
      lineRows: [baseLine],
      receipts: [{ ...receipt, po_line_unit_cost_cents: 600 }],
    });
    expect(a).not.toBe(b);
  });

  it("is stable for the identical snapshot (idempotent hash)", () => {
    const a = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [] });
    const b = computeVendorBillSourceHash({ header, lineRows: [baseLine], receipts: [] });
    expect(a).toBe(b);
  });
});
