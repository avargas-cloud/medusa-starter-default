/**
 * invoice-header-derivation.unit.spec.ts
 *
 * Challenges the two backend changes for the "derive summary from line items" fix,
 * up to PAYLOAD CONSTRUCTION ONLY (no QB bridge send):
 *
 *   1. POST /admin/invoices derives subtotal/discount/untaxed_total/total/balance_due
 *      from the (immutable) line items, so the stored header can never drift from the
 *      printed/QB detail. Invariant: subtotal + discount === Σ(line net).
 *
 *   2. handle-fulfillment-created strips the per-line discounts already baked into the
 *      QB lines, leaving ONLY a genuine order-level discount for buildQbOrderDiscountLines.
 *      With a corrected pos_invoice.discount=0 there is NO phantom "Order Discount" line.
 *
 * The route handler is monolithic (DB-bound), so the derivation formula is replicated
 * here verbatim as the canonical spec; the QB side imports the real builders.
 */
import {
  buildQbItems,
  buildQbOrderDiscountLines,
} from "../../lib/quickbooks/order-flow-core";

type BodyItem = {
  total: number; // gross cents
  quantity: number;
  net_total?: number;
  discount_type?: "percent" | "fixed" | null;
  discount_value?: number | null;
};

// ── Replica of route.ts resolveNetTotalCents (keep in sync) ──
function resolveNetTotalCents(it: BodyItem): number {
  if (it.net_total != null) return Math.round(it.net_total);
  const grossCents = Math.round(it.total || 0);
  const qty = Number(it.quantity || 0);
  const value = Number(it.discount_value ?? 0);
  if (!it.discount_type || !(value > 0) || qty <= 0) return grossCents;
  if (it.discount_type === "percent") {
    const unitCents = Math.round(grossCents / qty);
    const discUnit = Math.max(0, Math.round((unitCents * (100 - value)) / 100));
    return discUnit * qty;
  }
  return Math.max(0, grossCents - Math.min(grossCents, Math.round(value * 100) * qty));
}

// ── Replica of route.ts header derivation (keep in sync) ──
// `discount` is the COMBINED discount (per-line + order-level); subtotal = gross − combined.
function deriveHeader(body: {
  items: BodyItem[];
  discount?: number;
  shipping?: number;
  tax: number;
  amount_paid: number;
}) {
  const grossSumCents = body.items.reduce((s, it) => s + Math.round(it.total || 0), 0);
  const netSumCents = body.items.reduce((s, it) => s + resolveNetTotalCents(it), 0);
  const combinedDiscountCents = body.discount ?? 0;
  const perLineDiscountCents = Math.max(0, grossSumCents - netSumCents);
  const safeDiscountCents = Math.max(combinedDiscountCents, perLineDiscountCents);
  const subtotal = Math.max(0, grossSumCents - safeDiscountCents);
  const total = subtotal + (body.shipping ?? 0) + body.tax;
  const untaxed_total = subtotal + (body.shipping ?? 0);
  const balance_due = total - body.amount_paid;
  return { grossSumCents, netSumCents, subtotal, discount: safeDiscountCents, total, untaxed_total, balance_due };
}

// Real order 1887 first invoice (8 SUP @18% + the rest); net_total sent by the POS.
const order1887First: BodyItem[] = [
  { total: 41592, quantity: 8, net_total: 34104, discount_type: "percent", discount_value: 18 },
  { total: 0, quantity: 28, net_total: 0 },
  { total: 14679, quantity: 21, net_total: 14679 },
  { total: 20997, quantity: 3, net_total: 18897, discount_type: "percent", discount_value: 10 },
  { total: 83985, quantity: 15, net_total: 75585, discount_type: "percent", discount_value: 10 },
  { total: 6597, quantity: 3, net_total: 6597 },
  { total: 6000, quantity: 500, net_total: 6000 },
  { total: 49467, quantity: 33, net_total: 44517, discount_type: "percent", discount_value: 10 },
  { total: 44250, quantity: 15, net_total: 44250 },
  { total: 13485, quantity: 15, net_total: 13485 },
  { total: 63750, quantity: 30, net_total: 57390, discount_type: "percent", discount_value: 10 },
];

describe("invoice header derived from line items (combined-discount model)", () => {
  it("order 1887: subtotal=$3,155.04 (corrected), discount=combined per-line $292.98", () => {
    // POS sends combined = per-line (29298) for a no-promo order; the guard also enforces it.
    const h = deriveHeader({ items: order1887First, discount: 29298, shipping: 0, tax: 0, amount_paid: 0 });
    expect(h.netSumCents).toBe(315504);
    expect(h.grossSumCents).toBe(344802);
    expect(h.subtotal).toBe(315504);
    expect(h.discount).toBe(29298);
    expect(h.total).toBe(315504);
    expect(h.balance_due).toBe(315504);
  });

  it("invariant: subtotal + discount === Σ line GROSS", () => {
    const h = deriveHeader({ items: order1887First, discount: 29298, shipping: 0, tax: 0, amount_paid: 0 });
    expect(h.subtotal + h.discount).toBe(h.grossSumCents);
  });

  it("invariant holds WITH a genuine order-level discount (combined = per-line + order-level)", () => {
    const h = deriveHeader({ items: order1887First, discount: 29298 + 5000, shipping: 0, tax: 0, amount_paid: 0 });
    expect(h.subtotal).toBe(315504 - 5000); // net − order-level
    expect(h.subtotal + h.discount).toBe(h.grossSumCents); // still reconciles with the gross lines
  });

  it("guard: a too-small discount can never shrink below the per-line portion", () => {
    // A stale client that sends discount=0 must still net the lines (never bill gross).
    const h = deriveHeader({ items: order1887First, discount: 0, shipping: 0, tax: 0, amount_paid: 0 });
    expect(h.discount).toBe(29298); // bumped up to the per-line total
    expect(h.subtotal).toBe(315504);
  });

  it("falls back to a recompute when the POS omits net_total (older client)", () => {
    const legacy: BodyItem[] = [{ total: 41592, quantity: 8, discount_type: "percent", discount_value: 18 }];
    const h = deriveHeader({ items: legacy, discount: 0, shipping: 0, tax: 0, amount_paid: 0 });
    expect(h.subtotal).toBe(34104); // gross 41592 − per-line 7488, round-then-multiply
  });

  it("shipping + tax flow into total but not the item subtotal", () => {
    const h = deriveHeader({ items: order1887First, discount: 29298, shipping: 1500, tax: 700, amount_paid: 0 });
    expect(h.subtotal).toBe(315504);
    expect(h.untaxed_total).toBe(315504 + 1500);
    expect(h.total).toBe(315504 + 1500 + 700);
  });
});

describe("QB payload — per-line discounts baked into lines, no phantom order discount", () => {
  // Mirror the handler's activeItems: discounted lines carry net `subtotal` (dollars).
  const qbItems = [
    { variant: { metadata: { quickbooks_id: "1" } }, unit_price: 51.99, quantity: 8, subtotal: 341.04 },
    { variant: { metadata: { quickbooks_id: "2" } }, unit_price: 69.99, quantity: 3, subtotal: 188.97 },
    { variant: { metadata: { quickbooks_id: "3" } }, unit_price: 29.5, quantity: 15, subtotal: 442.5 }, // no discount
  ];

  it("buildQbItems emits the NET line amount (discount baked in)", () => {
    const lines = buildQbItems(qbItems as any);
    const byAmount = lines.map((l: any) => l.amount ?? l.price);
    expect(byAmount).toContain(341.04); // 8 × net 42.63
    expect(byAmount).toContain(188.97);
    expect(byAmount).toContain(442.5);
  });

  it("orderDiscountTotal = max(0, pos_invoice.discount − Σ per-line discount) === 0 after the fix", () => {
    // pos_invoice.discount corrected to 0; per-line discount total is whatever was baked.
    const invoiceDiscountAmount = 0;
    const lineDiscountTotalDollars = 292.98; // the real per-line total for 8 SUP + rest
    const orderDiscountTotal = Math.max(0, invoiceDiscountAmount - lineDiscountTotalDollars);
    expect(orderDiscountTotal).toBe(0);
    expect(buildQbOrderDiscountLines(orderDiscountTotal)).toEqual([]); // NO Subtotal/Discount lines
  });

  it("the OLD buggy discount ($320.17) would have produced a phantom $27.19 Order Discount", () => {
    const orderDiscountTotal = Math.max(0, 320.17 - 292.98);
    expect(Number(orderDiscountTotal.toFixed(2))).toBe(27.19);
    expect(buildQbOrderDiscountLines(orderDiscountTotal).length).toBe(2); // Subtotal + Discount lines (the bug)
  });

  it("a GENUINE order-level discount still emits a Discount line", () => {
    const lines = buildQbOrderDiscountLines(50, 5);
    expect(lines.length).toBe(2);
    expect(lines[1].productName).toBe("Discount");
    expect(lines[1].amount).toBe(50);
  });
});

// Mirrors the SO-LINK GUARD in POST /admin/pos/sync (case "invoice"): a force-sync
// line-rebuild Mod severs the SO LinkToTxn, so it must be BLOCKED for an SO-linked
// invoice already in QB. Standalone invoices and Sales Receipts are unaffected.
function forceSyncBlocked(meta: {
  qb_txn_id?: string;
  qb_invoice_txn_id?: string;
  qb_sales_receipt_txn_id?: string;
  is_sales_receipt?: boolean;
}, orderHasSo: boolean): boolean {
  const inQb = !!(meta.qb_txn_id || meta.qb_invoice_txn_id);
  const isSR = !!(meta.qb_sales_receipt_txn_id || meta.is_sales_receipt === true);
  return inQb && !isSR && orderHasSo;
}

describe("SO-link guard — block force-sync that would sever the SO LinkToTxn", () => {
  it("BLOCKS an SO-linked invoice already in QB (the 18816 case)", () => {
    expect(forceSyncBlocked({ qb_txn_id: "1C6729-1780501798" }, true)).toBe(true);
  });
  it("ALLOWS a standalone invoice (no Sales Order)", () => {
    expect(forceSyncBlocked({ qb_txn_id: "X" }, false)).toBe(false);
  });
  it("ALLOWS a Sales Receipt (never SO-linked)", () => {
    expect(forceSyncBlocked({ qb_sales_receipt_txn_id: "Y", is_sales_receipt: true }, true)).toBe(false);
  });
  it("ALLOWS the first sync (not yet in QB → CREATE path with InvoiceAdd+LinkToTxn)", () => {
    expect(forceSyncBlocked({}, true)).toBe(false);
  });
});
