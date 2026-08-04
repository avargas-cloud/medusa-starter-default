/**
 * qb-repair-plan.ts
 *
 * Derives the ordered sequence of QuickBooks operations that takes a purchase
 * order from what QuickBooks currently holds to what the POS says is true.
 *
 * WHY THIS EXISTS (2026-08-04)
 * ---------------------------
 * Reducing a PO whose Vendor Bill is already posted in QuickBooks is a CYCLE,
 * not a chain:
 *
 *   - The PO Mod is refused (error 3060, "this quantity is less than what
 *     you've already entered on 1 or more bills linked to this line") because
 *     the Bill in QuickBooks still claims the old quantities.
 *   - The Bill cannot be corrected first, because `BillMod` CANNOT CREATE
 *     PO-LINKED LINES — `LinkToTxn` exists only on `BillAdd` (same for
 *     `ItemReceiptMod`). So a final Bill that includes a new PO line is
 *     unreachable by Mod.
 *
 * The cycle only breaks by DELETING the Bill from QuickBooks and letting the
 * operator's normal Confirm re-add it. That is not merely the tidier option;
 * it is the only one that produces a correct final document.
 *
 * PURE ON PURPOSE. Everything QuickBooks knows arrives as input, resolved by a
 * read-only preflight. A planner that queried the bridge itself could not be
 * tested without one, and this is the piece whose correctness matters most:
 * its output authorises a hard delete of an accounting document.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never emits the final `BillAdd`. Re-creating the Bill posts AVCO/COGS and
 * is the operator's Confirm & Lock Costs — never a side effect of a repair.
 * The plan ends by handing that back, which is also why the UI has to make the
 * unfinished state impossible to miss.
 */

/** A PO line as the POS now says it should be. */
export interface DesiredPoLine {
  po_line_id: string;
  sku: string;
  /** Quantity the PO should order after the edit. 0 means the line is gone. */
  qty_ordered: number;
  /** True when this line does not exist in QuickBooks yet. */
  is_new: boolean;
}

/** What QuickBooks currently holds against a PO line. */
export interface QbPoLineState {
  po_line_id: string;
  /** Quantity on the QB purchase order. */
  qty_ordered: number;
  /** Units claimed by Bills in QuickBooks ("Qty on Bills"). */
  qty_on_bills: number;
  /** Units claimed by Item Receipts in QuickBooks. */
  qty_on_receipts: number;
}

/** A Bill that exists in QuickBooks and is linked to this PO. */
export interface QbLinkedBill {
  vendor_bill_id: string;
  number: string | null;
  qb_txn_id: string;
  /** Payment links found by the preflight. A paid Bill cannot be deleted. */
  has_payment_links: boolean;
}

/** An Item Receipt that exists in QuickBooks and is linked to this PO. */
export interface QbLinkedReceipt {
  receipt_id: string;
  number: string | null;
  qb_txn_id: string;
  /** Units this receipt claims, by PO line. */
  qty_by_po_line: Record<string, number>;
}

export interface RepairPlanInput {
  purchase_order_id: string;
  desired_lines: DesiredPoLine[];
  qb_lines: QbPoLineState[];
  qb_bills: QbLinkedBill[];
  qb_receipts: QbLinkedReceipt[];
}

export type RepairStepKind =
  | "bill_delete"
  | "receipt_delete"
  | "po_mod"
  | "receipt_add"
  | "bill_add_by_operator";

export interface RepairStep {
  ordinal: number;
  kind: RepairStepKind;
  /** Local id of the document this step acts on, when it targets one. */
  target_id: string | null;
  /** Operator-facing sentence. This is what the confirmation modal renders. */
  description: string;
}

export type RepairPlan =
  | { required: false; reason: "in_sync" }
  | {
      required: true;
      blocked: true;
      blocked_code: "bill_has_payments";
      /** Bills that must be dealt with in QuickBooks before anything runs. */
      blocking_bills: QbLinkedBill[];
      steps: [];
    }
  | {
      required: true;
      blocked: false;
      steps: RepairStep[];
      /** PO lines whose reduction is what forced the repair. */
      contracting_lines: Array<{ po_line_id: string; sku: string; from: number; to: number }>;
    };

/**
 * Returns the ordered repair sequence, or `required: false` when QuickBooks
 * already agrees with the POS.
 *
 * The order is fixed and not negotiable, because each step removes the claim
 * that would make the next one fail:
 *
 *   1. delete the Bills that claim more than the PO will order
 *   2. delete the Receipts that claim more than the PO will order
 *   3. PO Mod to the final shape
 *   4. re-add the Receipts (their PO links can only be made on Add)
 *   5. hand the Bill back to the operator's Confirm
 */
export function deriveRepairPlan(input: RepairPlanInput): RepairPlan {
  const desiredByLine = new Map(
    input.desired_lines.map((l) => [l.po_line_id, l])
  );

  // A repair is forced by CONTRACTION only. Adding lines or raising quantities
  // never trips QuickBooks: a PO may always order more than is billed or
  // received. This is why an operator adding two items that actually arrived
  // is not, by itself, a reason to touch any other document.
  const contracting: Array<{
    po_line_id: string;
    sku: string;
    from: number;
    to: number;
  }> = [];
  for (const qb of input.qb_lines) {
    const desired = desiredByLine.get(qb.po_line_id);
    const nextQty = desired?.qty_ordered ?? 0;
    if (nextQty >= qb.qty_ordered) continue;
    // Only a contraction that lands BELOW an existing claim needs a repair.
    if (nextQty >= qb.qty_on_bills && nextQty >= qb.qty_on_receipts) continue;
    contracting.push({
      po_line_id: qb.po_line_id,
      sku: desired?.sku ?? qb.po_line_id,
      from: qb.qty_ordered,
      to: nextQty,
    });
  }

  if (contracting.length === 0) {
    return { required: false, reason: "in_sync" };
  }

  const contractingLineIds = new Set(contracting.map((c) => c.po_line_id));

  // A Bill with money applied to it cannot be deleted, and no reordering makes
  // that safe. The repair stops here and names the documents, rather than
  // emitting a sequence whose first step is known to be refused.
  const paidBills = input.qb_bills.filter((b) => b.has_payment_links);
  if (paidBills.length > 0) {
    return {
      required: true,
      blocked: true,
      blocked_code: "bill_has_payments",
      blocking_bills: paidBills,
      steps: [],
    };
  }

  const steps: RepairStep[] = [];
  let ordinal = 1;

  for (const bill of input.qb_bills) {
    steps.push({
      ordinal: ordinal++,
      kind: "bill_delete",
      target_id: bill.vendor_bill_id,
      description: `Delete ${bill.number ?? "the Vendor Bill"} from QuickBooks so the purchase order can be reduced. It stays here as a draft.`,
    });
  }

  // Receipts also hold claims against the PO. Releasing the Bill alone is not
  // enough — and a receipt that must both lose old lines and gain new ones has
  // to be deleted and re-added, because `ItemReceiptMod` cannot create the PO
  // link either.
  const receiptsToRebuild = input.qb_receipts.filter((receipt) =>
    Object.entries(receipt.qty_by_po_line).some(
      ([poLineId, qty]) =>
        contractingLineIds.has(poLineId) &&
        qty > (desiredByLine.get(poLineId)?.qty_ordered ?? 0)
    )
  );

  for (const receipt of receiptsToRebuild) {
    steps.push({
      ordinal: ordinal++,
      kind: "receipt_delete",
      target_id: receipt.receipt_id,
      description: `Delete item receipt ${receipt.number ?? receipt.receipt_id} from QuickBooks — it claims more units than the purchase order will order.`,
    });
  }

  steps.push({
    ordinal: ordinal++,
    kind: "po_mod",
    target_id: input.purchase_order_id,
    description:
      "Update the purchase order in QuickBooks to its corrected quantities and lines.",
  });

  for (const receipt of receiptsToRebuild) {
    steps.push({
      ordinal: ordinal++,
      kind: "receipt_add",
      target_id: receipt.receipt_id,
      description: `Re-create item receipt ${receipt.number ?? receipt.receipt_id} in QuickBooks, linked to the corrected purchase order.`,
    });
  }

  steps.push({
    ordinal: ordinal++,
    kind: "bill_add_by_operator",
    target_id: null,
    description:
      "Then YOU confirm the Vendor Bill. That re-creates it in QuickBooks and posts its costs — the repair never does this on its own.",
  });

  return { required: true, blocked: false, steps, contracting_lines: contracting };
}
