/**
 * verify-qb-bill-match.ts — unit checks for the pure QB Bill Match logic
 * (reconstruction + classification). No bridge, no DB.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/verify/verify-qb-bill-match.ts
 */

import { reconstructLocalBill, type PoLineForMatch } from "../../api/admin/quickbooks/bill-match/_lib/reconstruct";
import { classifyMismatch, classifyQbLinkState } from "../../api/admin/quickbooks/bill-match/_lib/classify";
import type { QbBill } from "../../api/admin/quickbooks/bill-match/_lib/bill-query";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

function makeBill(over: Partial<QbBill>): QbBill {
  return {
    txn_id: "T1",
    edit_sequence: "1",
    ref_number: "INV-1",
    txn_date: "2026-07-01",
    memo: "",
    vendor_list_id: "V1",
    vendor_full_name: "Acme",
    amount_due_cents: 0,
    total_cents: 0,
    item_lines: [],
    expense_lines: [],
    linked_txns: [],
    ...over,
  };
}

function poLine(over: Partial<PoLineForMatch>): PoLineForMatch {
  return {
    po_line_id: "pol_1",
    qb_txn_line_id: "100",
    product_variant_id: "var_1",
    variant_qb_item_list_id: "L1",
    sku: "SKU-1",
    cbm_per_unit: null,
    qty_ordered: 10,
    already_billed_qty: 0,
    ...over,
  };
}

console.log("reconstructLocalBill:");
{
  // Happy path: bill item resolves by ItemRef ListID, qty within bound.
  const bill = makeBill({
    item_lines: [
      { txn_line_id: "1", item_list_id: "L1", item_full_name: "Widget", quantity: 4, cost_cents: 500, amount_cents: 2000, linked_txn_id: "", linked_txn_line_id: "" },
    ],
    expense_lines: [
      { txn_line_id: "2", account_list_id: "A9", account_full_name: "Freight and Shipping Costs", amount_cents: 1500, memo: "ocean freight" },
    ],
  });
  const r = reconstructLocalBill(bill, [poLine({})]);
  check("ok when items ⊆ PO", r.ok === true && r.errors.length === 0);
  check("1 product line reconstructed", r.item_lines.length === 1 && r.item_lines[0]?.po_line_id === "pol_1");
  check("records bill cost on the line (500¢)", r.item_lines[0]?.unit_cost_cents === 500);
  check("1 freight expense line", r.expense_lines.length === 1 && r.expense_lines[0]?.account_list_id === "A9");
}
{
  // Resolve by LinkToTxn (TxnLineID) even when ItemRef is absent.
  const bill = makeBill({
    item_lines: [
      { txn_line_id: "1", item_list_id: "", item_full_name: "", quantity: 2, cost_cents: 100, amount_cents: 200, linked_txn_id: "PO99", linked_txn_line_id: "100" },
    ],
  });
  const r = reconstructLocalBill(bill, [poLine({ variant_qb_item_list_id: null })]);
  check("resolves item via LinkToTxn TxnLineID", r.ok && r.item_lines[0]?.po_line_id === "pol_1");
}
{
  // Bill item NOT on the PO → hard reject.
  const bill = makeBill({
    item_lines: [
      { txn_line_id: "1", item_list_id: "L-UNKNOWN", item_full_name: "Rogue", quantity: 1, cost_cents: 100, amount_cents: 100, linked_txn_id: "", linked_txn_line_id: "" },
    ],
  });
  const r = reconstructLocalBill(bill, [poLine({})]);
  check("rejects item_not_on_po", !r.ok && r.errors.some((e) => e.code === "item_not_on_po"));
}
{
  // Qty exceeds (ordered − already billed).
  const bill = makeBill({
    item_lines: [
      { txn_line_id: "1", item_list_id: "L1", item_full_name: "Widget", quantity: 8, cost_cents: 100, amount_cents: 800, linked_txn_id: "", linked_txn_line_id: "" },
    ],
  });
  const r = reconstructLocalBill(bill, [poLine({ qty_ordered: 10, already_billed_qty: 5 })]);
  check("rejects qty_exceeds_unbilled (8 > 10−5)", !r.ok && r.errors.some((e) => e.code === "qty_exceeds_unbilled"));
}
{
  // Exactly at the unbilled bound is allowed.
  const bill = makeBill({
    item_lines: [
      { txn_line_id: "1", item_list_id: "L1", item_full_name: "Widget", quantity: 5, cost_cents: 100, amount_cents: 500, linked_txn_id: "", linked_txn_line_id: "" },
    ],
  });
  const r = reconstructLocalBill(bill, [poLine({ qty_ordered: 10, already_billed_qty: 5 })]);
  check("allows qty == unbilled bound (5 == 10−5)", r.ok && r.item_lines.length === 1);
}

console.log("classifyQbLinkState:");
{
  const bill = makeBill({ linked_txns: [{ txn_type: "PurchaseOrder", txn_id: "PO-A" }] });
  check("this_po", classifyQbLinkState({ bill, poQbTxnId: "PO-A", receiptQbIds: [] }) === "this_po");
  check("other_po", classifyQbLinkState({ bill, poQbTxnId: "PO-B", receiptQbIds: [] }) === "other_po");
}
{
  const bill = makeBill({ linked_txns: [{ txn_type: "ItemReceipt", txn_id: "IR-1" }] });
  check("this_po_receipt", classifyQbLinkState({ bill, poQbTxnId: "PO-A", receiptQbIds: ["IR-1"] }) === "this_po_receipt");
}
{
  const bill = makeBill({ linked_txns: [] });
  check("none when unlinked", classifyQbLinkState({ bill, poQbTxnId: "PO-A", receiptQbIds: [] }) === "none");
}

console.log("classifyMismatch:");
{
  const red = classifyMismatch({ vendorMatches: false, alreadyAdoptedLocal: false, qbLinkState: "none", billTotalCents: 1000, poReferenceCents: 1000 });
  check("red on vendor mismatch", red.band === "red");
  const red2 = classifyMismatch({ vendorMatches: true, alreadyAdoptedLocal: true, qbLinkState: "none", billTotalCents: 1000, poReferenceCents: 1000 });
  check("red on already adopted", red2.band === "red");
  const red3 = classifyMismatch({ vendorMatches: true, alreadyAdoptedLocal: false, qbLinkState: "other_po", billTotalCents: 1000, poReferenceCents: 1000 });
  check("red on linked to other PO", red3.band === "red");
  const green = classifyMismatch({ vendorMatches: true, alreadyAdoptedLocal: false, qbLinkState: "none", billTotalCents: 10000, poReferenceCents: 10050 });
  check("green within 1%/$1 tolerance", green.band === "green");
  const amber = classifyMismatch({ vendorMatches: true, alreadyAdoptedLocal: false, qbLinkState: "none", billTotalCents: 12000, poReferenceCents: 10000 });
  check("amber on explainable delta", amber.band === "amber" && amber.reasons.length > 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
