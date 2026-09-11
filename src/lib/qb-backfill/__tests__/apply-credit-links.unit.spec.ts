import { collectCreditLinks, pairKey, planCreditApplications } from "../apply-credit-links";
import type { QbBill, QbVendorCredit } from "../types";

function bill(txn: string, links: Array<[string, number]>, date = "2026-02-10"): QbBill {
  return {
    txn_id: txn, edit_sequence: "1", ref_number: null, vendor_ref: { list_id: "v1", full_name: "V" },
    ap_account_ref: null, txn_date: date, due_date: null, amount_due_cents: 1000, is_paid: true, memo: null,
    item_lines: [], expense_lines: [],
    linked_txns: links.map(([id, amt]) => ({ txn_id: id, txn_type: "VendorCredit", txn_date: null, amount_cents: amt, ref_number: null })),
  };
}
function credit(txn: string, links: Array<[string, number]>): QbVendorCredit {
  return {
    txn_id: txn, edit_sequence: "1", ref_number: null, vendor_ref: { list_id: "v1", full_name: "V" }, txn_date: "2026-03-01",
    amount_cents: 500, memo: null, item_lines: [], expense_lines: [],
    linked_txns: links.map(([id, amt]) => ({ txn_id: id, txn_type: "Bill", txn_date: null, amount_cents: amt, ref_number: null })),
  };
}
const creditIndex = new Map([["VC1", { id: "vc_1", vendor_id: "ven_a", total_cents: 1000, credit_date: "2026-03-01" }]]);
const billIndex = new Map([
  ["B1", { id: "vb_1", vendor_id: "ven_a", document_date: "2026-02-10" }],
  ["B2", { id: "vb_2", vendor_id: "ven_b", document_date: "2026-04-01" }],
]);

describe("qb-backfill/apply-credit-links", () => {
  it("une los dos lados del enlace sin duplicar el par y con el monto en positivo", () => {
    const pairs = collectCreditLinks([bill("B1", [["VC1", -700]])], [credit("VC1", [["B1", -700]])]);
    expect([...pairs.values()]).toEqual([{ credit_txn_id: "VC1", bill_txn_id: "B1", amount_cents: 700 }]);
  });
  it("planea la aplicación con applied_at = la fecha más tardía de los dos documentos", () => {
    const plan = planCreditApplications([bill("B1", [["VC1", -700]])], [], creditIndex, billIndex, new Set());
    expect(plan.rows).toEqual([{ credit_txn_id: "VC1", bill_txn_id: "B1", credit_id: "vc_1", vendor_bill_id: "vb_1", amount_cents: 700, applied_at: "2026-03-01" }]);
    expect(plan.skipped).toEqual([]);
  });
  it("ya existente → already; crédito o bill que el POS no tiene → missing", () => {
    const plan = planCreditApplications(
      [bill("B1", [["VC1", -700]]), bill("B9", [["VC1", -100]]), bill("B1", [["VC9", -50]])],
      [], creditIndex, billIndex, new Set([pairKey("vc_1", "vb_1")])
    );
    expect(plan.rows).toEqual([]);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["already", "bill_missing", "credit_missing"]);
  });
  it("vendor distinto → vendor_mismatch; la suma no supera el total del crédito → exceeds_credit", () => {
    const plan = planCreditApplications(
      [bill("B2", [["VC1", -100]]), bill("B1", [["VC1", -900]]), bill("B3", [["VC1", -200]])],
      [], creditIndex, new Map([...billIndex, ["B3", { id: "vb_3", vendor_id: "ven_a", document_date: "2026-05-01" }]]), new Set()
    );
    expect(plan.rows.map((r) => r.amount_cents)).toEqual([900]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["vendor_mismatch", "exceeds_credit"]);
  });
});
