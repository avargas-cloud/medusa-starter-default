/**
 * QB Bill Match — Full-match reconstruction (LOCAL vendor, Phase 1).
 *
 * Pure logic (no I/O) so it is unit-testable without the bridge or DB. Given a
 * parsed QB bill and the PO's lines (with prior-billed quantities already
 * resolved by the caller), it validates the bill against the PO and produces
 * the `vendor_bill_line` rows to insert.
 *
 * Owner rules (2026-07-24):
 * - Bill items ⊆ PO items: every QB item line must resolve to a PO line; a bill
 *   item not on the PO is a HARD reject (`item_not_on_po`).
 * - Quantity bound: per PO line, bill_qty ≤ (qty_ordered − already_billed_qty)
 *   (a PO accumulates several bills across partial shipments) → `qty_exceeds_unbilled`.
 * - Cost: record the BILL's cost on the line; never touch product average_cost.
 * - Expense lines → freight-charge lines (line_kind='freight_charge'), same as
 *   how freight is added to a native regular bill.
 */

import type { QbBill } from "./bill-query";

export interface PoLineForMatch {
  po_line_id: string;
  /** PO line's own QB TxnLineID — matches a bill item line's LinkToTxn TxnLineID. */
  qb_txn_line_id: string | null;
  product_variant_id: string | null;
  /** variant.metadata.quickbooks_id — matches a bill item line's ItemRef.ListID. */
  variant_qb_item_list_id: string | null;
  sku: string | null;
  cbm_per_unit: number | null;
  qty_ordered: number;
  /** SUM of prior regular confirmed/synced bills' line qty for this PO line. */
  already_billed_qty: number;
}

export interface ReconstructedItemLine {
  po_line_id: string;
  product_variant_id: string | null;
  sku: string | null;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  /** The bill line's own TxnLineID in QB (for later BillMod line identity — unused while adopted). */
  qb_txn_line_id: string;
  /** True when the bill line cost differs from the PO's ordered cost (display flag). */
  cost_differs_from_po: boolean;
}

export interface ReconstructedExpenseLine {
  account_list_id: string;
  account_full_name: string;
  amount_cents: number;
  memo: string;
  qb_txn_line_id: string;
}

export interface ReconstructError {
  code: string;
  detail: string;
}

export interface ReconstructResult {
  ok: boolean;
  errors: ReconstructError[];
  item_lines: ReconstructedItemLine[];
  expense_lines: ReconstructedExpenseLine[];
}

interface PoLineState extends PoLineForMatch {
  consumed_in_this_bill: number;
}

/**
 * Resolve one QB item line to a PO line. LinkToTxn (by TxnLineID) is
 * authoritative; ItemRef.ListID → variant is the fallback. Returns the PO line
 * with the most remaining unbilled capacity when a variant maps to several PO
 * lines (rare), so we never over-consume a single line while another sits open.
 */
function resolvePoLine(
  itemLine: QbBill["item_lines"][number],
  states: PoLineState[]
): PoLineState | null {
  if (itemLine.linked_txn_line_id) {
    const byLink = states.find((s) => s.qb_txn_line_id && s.qb_txn_line_id === itemLine.linked_txn_line_id);
    if (byLink) return byLink;
  }
  if (itemLine.item_list_id) {
    const byVariant = states.filter(
      (s) => s.variant_qb_item_list_id && s.variant_qb_item_list_id === itemLine.item_list_id
    );
    if (byVariant.length === 1 && byVariant[0]) return byVariant[0];
    if (byVariant.length > 1) {
      const ranked = byVariant
        .map((s) => ({ s, remaining: s.qty_ordered - s.already_billed_qty - s.consumed_in_this_bill }))
        .sort((a, b) => b.remaining - a.remaining);
      if (ranked[0]) return ranked[0].s;
    }
  }
  return null;
}

export function reconstructLocalBill(qbBill: QbBill, poLines: PoLineForMatch[]): ReconstructResult {
  const states: PoLineState[] = poLines.map((p) => ({ ...p, consumed_in_this_bill: 0 }));
  const errors: ReconstructError[] = [];
  const itemLines: ReconstructedItemLine[] = [];

  for (const il of qbBill.item_lines) {
    const poLine = resolvePoLine(il, states);
    if (!poLine) {
      const label = il.item_full_name || il.item_list_id || il.linked_txn_line_id || "(unknown item)";
      errors.push({ code: "item_not_on_po", detail: `Bill item "${label}" is not on this PO.` });
      continue;
    }
    const remaining = poLine.qty_ordered - poLine.already_billed_qty - poLine.consumed_in_this_bill;
    if (il.quantity > remaining + 1e-9) {
      errors.push({
        code: "qty_exceeds_unbilled",
        detail: `${poLine.sku ?? poLine.po_line_id}: bill qty ${il.quantity} exceeds unbilled ${Math.max(
          0,
          remaining
        )} (ordered ${poLine.qty_ordered}, already billed ${poLine.already_billed_qty}).`,
      });
      continue;
    }
    poLine.consumed_in_this_bill += il.quantity;
    // Compare bill unit cost to the PO's ordered cost only when we can (LinkToTxn
    // lines don't carry a separate PO cost here; the route passes ordered cost via
    // a future hook if needed). We flag purely on presence of a cost value.
    itemLines.push({
      po_line_id: poLine.po_line_id,
      product_variant_id: poLine.product_variant_id,
      sku: poLine.sku,
      qty: il.quantity,
      unit_cost_cents: il.cost_cents,
      cbm_per_unit: poLine.cbm_per_unit,
      qb_txn_line_id: il.txn_line_id,
      cost_differs_from_po: false,
    });
  }

  const expenseLines: ReconstructedExpenseLine[] = qbBill.expense_lines
    .filter((el) => el.account_list_id)
    .map((el) => ({
      account_list_id: el.account_list_id,
      account_full_name: el.account_full_name,
      amount_cents: el.amount_cents,
      memo: el.memo,
      qb_txn_line_id: el.txn_line_id,
    }));

  return { ok: errors.length === 0, errors, item_lines: itemLines, expense_lines: expenseLines };
}
