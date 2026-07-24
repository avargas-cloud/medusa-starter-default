/**
 * QB Bill Match — candidate classification (pure, unit-testable).
 *
 * Two independent signals the UI shows per candidate bill:
 *  - qb_link_state: what the bill is already linked to INSIDE QuickBooks
 *    (from IncludeLinkedTxns). Lets us flag a bill already tied to another PO.
 *  - mismatch band: green / amber / red guidance for the operator's eye-match.
 */

import type { QbBill } from "./bill-query";

export type QbLinkState = "this_po" | "this_po_receipt" | "other_po" | "unrelated" | "none";

export function classifyQbLinkState(args: {
  bill: QbBill;
  poQbTxnId: string | null;
  receiptQbIds: string[];
}): QbLinkState {
  const { bill, poQbTxnId, receiptQbIds } = args;
  const receiptSet = new Set(receiptQbIds.filter(Boolean));

  // Header LinkedTxn + per-item LinkToTxn both count.
  const links = [
    ...bill.linked_txns.map((l) => ({ type: l.txn_type, id: l.txn_id })),
    ...bill.item_lines
      .filter((il) => il.linked_txn_id)
      .map((il) => ({ type: "", id: il.linked_txn_id })),
  ];

  if (poQbTxnId && links.some((l) => l.id === poQbTxnId)) return "this_po";
  if (links.some((l) => receiptSet.has(l.id))) return "this_po_receipt";

  const hasPoOrReceiptLink = links.some(
    (l) => l.type === "PurchaseOrder" || l.type === "ItemReceipt"
  );
  if (hasPoOrReceiptLink) return "other_po";
  if (links.length > 0) return "unrelated";
  return "none";
}

export type MismatchBand = "green" | "amber" | "red";

export interface MismatchResult {
  band: MismatchBand;
  reasons: string[];
}

/**
 * Amount tolerance: within 1% OR $1 of the PO reference value counts as a match.
 * Freight/tax/partials legitimately push the bill total off the PO merchandise
 * value, so an amount gap alone is amber (explainable), never red.
 */
export function classifyMismatch(args: {
  vendorMatches: boolean;
  alreadyAdoptedLocal: boolean;
  qbLinkState: QbLinkState;
  billTotalCents: number;
  poReferenceCents: number;
}): MismatchResult {
  const { vendorMatches, alreadyAdoptedLocal, qbLinkState, billTotalCents, poReferenceCents } = args;
  const reasons: string[] = [];

  // RED — structural blockers.
  if (!vendorMatches) reasons.push("Bill vendor does not match the PO vendor.");
  if (alreadyAdoptedLocal) reasons.push("This QB bill is already recorded locally.");
  if (qbLinkState === "other_po") reasons.push("Bill is already linked to a different PO/receipt in QuickBooks.");
  if (reasons.length > 0) return { band: "red", reasons };

  // Amount comparison → green vs amber.
  const delta = Math.abs(billTotalCents - poReferenceCents);
  const within = delta <= 100 || (poReferenceCents > 0 && delta / poReferenceCents <= 0.01);
  if (within) return { band: "green", reasons };

  const sign = billTotalCents >= poReferenceCents ? "+" : "−";
  reasons.push(
    `Bill total ${sign}$${(delta / 100).toFixed(2)} vs PO value $${(poReferenceCents / 100).toFixed(
      2
    )} (freight/tax/partial shipments can explain this).`
  );
  return { band: "amber", reasons };
}
