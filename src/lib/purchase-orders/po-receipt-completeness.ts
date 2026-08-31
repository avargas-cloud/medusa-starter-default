/**
 * src/lib/purchase-orders/po-receipt-completeness.ts
 *
 * Whether a purchase order has fully ARRIVED — and whether this bill is one
 * that may only be confirmed once it has.
 *
 * WHY THIS EXISTS
 * ---------------
 * `po-billed-quantities.ts` (its sibling) answers how much of a PO is still
 * BILLABLE and closes with: "Whether a bill may be CONFIRMED is a separate
 * question answered by the confirm route, which still requires the goods to
 * have been received." This is that separate question, and the confirm route
 * was answering it wrong for one class of bill.
 *
 * The confirm route allows `received` OR `partially_received` on purpose —
 * "Option A: per-shipment confirm". For a local vendor that is right: they
 * invoice each shipment, so a bill per delivery mirrors a real document.
 *
 * A CHINA PURCHASING AGENT does not work that way. There are no per-shipment
 * invoices: the agent issues ONE bill for the whole purchase order. Confirming
 * on a partial arrival therefore mints a bill that matches no document the
 * supplier ever produced — and posts it to QuickBooks (owner rule, 2026-08-31).
 *
 * WHY NOT `purchase_order.status`
 * -------------------------------
 * Because it is a DISPLAY tag, not a measurement. `po-received-status.ts` only
 * rewrites receipt-driven tags and a manual one always wins (2026-07-03), so a
 * PO can read `received` with units still outstanding and would sail through a
 * status-based gate with nothing to warn anybody. Measured against production
 * the day this was written: no agent PO is in that state yet — the trap is open
 * and simply has not been sprung.
 *
 * So completeness is MEASURED, against ORDERED, exactly as the Billed column
 * learned to (2026-08-13): `Σ qty_received ≥ Σ(qty_ordered − qty_cancelled)`
 * over live lines. Same yardstick as `resolveRemainingPoQuantities`; if the two
 * ever disagreed, a PO could read "nothing left to bill" and "not fully
 * received" at once.
 *
 * WHY THE VENDOR FLAG DECIDES HERE, WHEN `qb-vendor-bill-enqueue.ts` SAYS IT
 * DECIDES NOTHING
 * -------------------------------------------------------------------------
 * Both statements are true because they answer different questions, and the
 * distinction is easy to lose:
 *
 *   · The SHAPE of the QuickBooks document is decided by STRUCTURE — whether
 *     the bill has linked siblings whose money is already inside its landed
 *     cost. QuickBooks knows nothing about our agent relationship, so the flag
 *     must not decide that (2026-08-04).
 *   · WHEN a bill may be confirmed is a commercial policy of OUR side: it
 *     describes how the supplier invoices us. That is precisely what the flag
 *     records, and structure cannot answer it — the sibling bills may not even
 *     exist yet at the moment somebody presses Confirm.
 *
 * Read LIVE from the vendor row, never from the PO's snapshot, so flipping a
 * vendor takes effect immediately — the same rule `china-transfer.ts` follows.
 */

import { VENDOR_IS_CHINA_AGENT_SQL } from "../../api/admin/purchase-orders/_lib/china-transfer";

export interface CompletenessKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

export interface PoReceiptFacts {
  /** `Σ(qty_ordered − qty_cancelled)` over live lines, floored per line at 0. */
  qty_ordered: number;
  /** `Σ qty_received` over the same lines. */
  qty_received: number;
}

export interface ConfirmReceiptFacts extends PoReceiptFacts {
  /** The bill's vendor is flagged as a purchasing agent (live read). */
  is_agent_purchase: boolean;
  /** A bill with no purchase order has nothing to be complete about. */
  has_purchase_order: boolean;
}

export type ConfirmReceiptVerdict =
  | { satisfied: true; reason: string }
  | { satisfied: false; reason: string; qty_outstanding: number };

/**
 * PURE. Given the numbers, may this bill be confirmed?
 *
 * `>=` and not `===` deliberately: over-receipt is a real state (a vendor ships
 * extra) and it is not a reason to block an invoice that has already arrived.
 * The cap on over-billing lives in `po-billed-quantities.ts`, not here.
 */
export function decideConfirmReceiptRequirement(
  facts: ConfirmReceiptFacts
): ConfirmReceiptVerdict {
  if (!facts.is_agent_purchase || !facts.has_purchase_order) {
    // Per-shipment confirm stays exactly as it was for everybody else. This is
    // the assertion that keeps purchasing's daily flow working, and the E2E
    // states it as a negative test for the same reason.
    return { satisfied: true, reason: "per-shipment confirm applies" };
  }
  const outstanding = facts.qty_ordered - facts.qty_received;
  if (outstanding <= 0) {
    return { satisfied: true, reason: "the purchase order arrived in full" };
  }
  return {
    satisfied: false,
    qty_outstanding: outstanding,
    reason:
      `This purchase order is billed in full by the purchasing agent, so it ` +
      `must arrive in full first — ${facts.qty_received} of ${facts.qty_ordered} ` +
      `units received, ${outstanding} still outstanding`,
  };
}

/** Measures arrival against what was ORDERED. Never reads `purchase_order.status`. */
export async function loadPoReceiptFacts(
  knex: CompletenessKnex,
  purchaseOrderId: string
): Promise<PoReceiptFacts> {
  const result = await knex.raw(
    `SELECT
        COALESCE(SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)), 0)::int
          AS qty_ordered,
        COALESCE(SUM(COALESCE(pol.qty_received, 0)), 0)::int
          AS qty_received
       FROM purchase_order_line pol
      WHERE pol.purchase_order_id = ?
        AND pol.deleted_at IS NULL`,
    [purchaseOrderId]
  );
  const row = result.rows[0] as
    | { qty_ordered: number | string; qty_received: number | string }
    | undefined;
  return {
    qty_ordered: Number(row?.qty_ordered ?? 0),
    qty_received: Number(row?.qty_received ?? 0),
  };
}

/**
 * Everything the confirm gate and the POS button need, from one read.
 *
 * BOTH consume this: the route enforces it and the screen reflects it. A screen
 * that derived the same rule from its own copy is how a button and a route end
 * up disagreeing — the failure this repo has already paid for twice with the
 * supervisor PIN.
 */
export async function loadConfirmReceiptFacts(
  knex: CompletenessKnex,
  vendorBillId: string
): Promise<ConfirmReceiptFacts | null> {
  const result = await knex.raw(
    `SELECT vb.purchase_order_id,
            COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false) AS is_agent
       FROM vendor_bill vb
       LEFT JOIN purchase_order po
              ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
       LEFT JOIN qb_vendor v ON v.id = po.vendor_id
      WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [vendorBillId]
  );
  const row = result.rows[0] as
    | { purchase_order_id: string | null; is_agent: boolean }
    | undefined;
  if (!row) return null;

  if (!row.purchase_order_id) {
    return {
      is_agent_purchase: Boolean(row.is_agent),
      has_purchase_order: false,
      qty_ordered: 0,
      qty_received: 0,
    };
  }
  const qty = await loadPoReceiptFacts(knex, row.purchase_order_id);
  return {
    is_agent_purchase: Boolean(row.is_agent),
    has_purchase_order: true,
    ...qty,
  };
}
