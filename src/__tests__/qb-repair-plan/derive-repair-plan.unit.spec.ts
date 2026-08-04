/**
 * The repair planner authorises hard-deleting accounting documents from
 * QuickBooks, so what it must NOT do matters as much as what it does.
 *
 * The two that would hurt most:
 *   - emitting a plan when nothing is actually blocked (deleting a Bill for no
 *     reason), and
 *   - emitting a sequence whose first step is known to be refused, instead of
 *     naming the paid Bill and stopping.
 */
import {
  deriveRepairPlan,
  type RepairPlanInput,
} from "../../lib/purchase-orders/qb-repair-plan";

function base(overrides: Partial<RepairPlanInput> = {}): RepairPlanInput {
  return {
    purchase_order_id: "po_1",
    desired_lines: [
      { po_line_id: "l1", sku: "SKU-A", qty_ordered: 20, is_new: false },
    ],
    qb_lines: [
      { po_line_id: "l1", qty_ordered: 50, qty_on_bills: 50, qty_on_receipts: 20 },
    ],
    qb_bills: [
      {
        vendor_bill_id: "vb_1",
        number: "VB-1059",
        qb_txn_id: "1CA86A",
        has_payment_links: false,
      },
    ],
    qb_receipts: [],
    ...overrides,
  };
}

describe("deriveRepairPlan", () => {
  it("asks for nothing when QuickBooks already agrees", () => {
    const plan = deriveRepairPlan(
      base({
        desired_lines: [
          { po_line_id: "l1", sku: "SKU-A", qty_ordered: 50, is_new: false },
        ],
      })
    );
    expect(plan.required).toBe(false);
  });

  it("asks for nothing when the PO only GROWS", () => {
    // QuickBooks never refuses a PO that orders more than is billed or
    // received. Adding the two items that actually arrived must not drag any
    // other document into a repair.
    const plan = deriveRepairPlan(
      base({
        desired_lines: [
          { po_line_id: "l1", sku: "SKU-A", qty_ordered: 80, is_new: false },
          { po_line_id: "l2", sku: "SKU-NEW", qty_ordered: 5, is_new: true },
        ],
      })
    );
    expect(plan.required).toBe(false);
  });

  it("asks for nothing when the reduction stays above every claim", () => {
    // 50 -> 30 with 20 billed and 20 received: still above both, so QuickBooks
    // has no objection and nothing should be deleted.
    const plan = deriveRepairPlan(
      base({
        desired_lines: [
          { po_line_id: "l1", sku: "SKU-A", qty_ordered: 30, is_new: false },
        ],
        qb_lines: [
          {
            po_line_id: "l1",
            qty_ordered: 50,
            qty_on_bills: 20,
            qty_on_receipts: 20,
          },
        ],
      })
    );
    expect(plan.required).toBe(false);
  });

  it("stops and names the Bill when money is applied to it", () => {
    const plan = deriveRepairPlan(
      base({
        qb_bills: [
          {
            vendor_bill_id: "vb_1",
            number: "VB-1059",
            qb_txn_id: "1CA86A",
            has_payment_links: true,
          },
        ],
      })
    );
    if (!plan.required || !plan.blocked) throw new Error("expected blocked");
    expect(plan.blocked_code).toBe("bill_has_payments");
    expect(plan.blocking_bills[0]?.number).toBe("VB-1059");
    // No sequence is offered: its first step would be refused.
    expect(plan.steps).toHaveLength(0);
  });

  it("orders bill delete before the PO mod, and hands the re-add back", () => {
    const plan = deriveRepairPlan(base());
    if (!plan.required || plan.blocked) throw new Error("expected a sequence");
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "bill_delete",
      "po_mod",
      "bill_add_by_operator",
    ]);
    expect(plan.contracting_lines).toEqual([
      { po_line_id: "l1", sku: "SKU-A", from: 50, to: 20 },
    ]);
  });

  it("deletes and RE-ADDS a receipt that claims more than the PO will order", () => {
    // ItemReceiptMod cannot create the PO link, so a receipt that has to shed
    // units is delete + add — never a Mod.
    const plan = deriveRepairPlan(
      base({
        qb_receipts: [
          {
            receipt_id: "por_1",
            number: "RCP-1157",
            qb_txn_id: "1CBF01",
            qty_by_po_line: { l1: 50 },
          },
        ],
      })
    );
    if (!plan.required || plan.blocked) throw new Error("expected a sequence");
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "bill_delete",
      "receipt_delete",
      "po_mod",
      "receipt_add",
      "bill_add_by_operator",
    ]);
    // The re-add must come AFTER the PO mod or its link has nothing to point at.
    const poMod = plan.steps.findIndex((s) => s.kind === "po_mod");
    const readd = plan.steps.findIndex((s) => s.kind === "receipt_add");
    expect(readd).toBeGreaterThan(poMod);
  });

  it("leaves alone a receipt that still fits inside the reduced PO", () => {
    const plan = deriveRepairPlan(
      base({
        qb_receipts: [
          {
            receipt_id: "por_1",
            number: "RCP-1150",
            qb_txn_id: "1CB718",
            qty_by_po_line: { l1: 20 },
          },
        ],
      })
    );
    if (!plan.required || plan.blocked) throw new Error("expected a sequence");
    expect(plan.steps.some((s) => s.kind === "receipt_delete")).toBe(false);
  });

  it("treats a deleted PO line as a contraction to zero", () => {
    const plan = deriveRepairPlan(base({ desired_lines: [] }));
    if (!plan.required || plan.blocked) throw new Error("expected a sequence");
    expect(plan.contracting_lines[0]?.to).toBe(0);
  });

  it("never emits the final BillAdd as something the repair performs", () => {
    const plan = deriveRepairPlan(base());
    if (!plan.required || plan.blocked) throw new Error("expected a sequence");
    const last = plan.steps[plan.steps.length - 1];
    expect(last.kind).toBe("bill_add_by_operator");
    expect(last.target_id).toBeNull();
  });
});
