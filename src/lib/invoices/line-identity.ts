/**
 * Delivery v2 — invoice line identity validation.
 *
 * Runs INSIDE the invoice-create transaction (same TxManager as
 * document-numbering.ts) so the over-invoice ceiling is enforced under an
 * order-scoped advisory lock: two concurrent creates for the same order
 * serialize here, and a failed validation rolls the whole create back.
 *
 * Fail-closed: an order_line_item_id that doesn't belong to the order, or a
 * quantity that would exceed remaining_to_invoice, rejects the create — we
 * never guess line identity (two same-SKU lines are otherwise
 * indistinguishable; see docs/DISPATCH_ON_ORDER_HANDOFF.md).
 */

import type { TxManager } from "./document-numbering";

export type ShipmentLinkMode = "legacy_1to1" | "derived_v2";

export class LineIdentityError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ORDER_LINE"
      | "OVER_INVOICE"
      | "INVALID_LINE_QUANTITY",
    message: string
  ) {
    super(message);
    this.name = "LineIdentityError";
  }
}

export interface LineIdentityItem {
  variant_id?: string | null;
  order_line_item_id?: string | null;
  quantity: number;
  description?: string;
}

/**
 * Which link mode the payload opts into. Pure — safe to call outside the tx.
 * 'derived_v2' requires EVERY merchandise line (variant_id present) to carry
 * its order_line_item_id; custom/comment lines (no variant) are exempt.
 */
export function resolveShipmentLinkMode(
  items: LineIdentityItem[]
): ShipmentLinkMode {
  const claimed = items.filter((it) => it.order_line_item_id);
  if (!claimed.length) return "legacy_1to1";
  const merchandise = items.filter((it) => it.variant_id);
  const allCovered = merchandise.every((it) => it.order_line_item_id);
  return allCovered ? "derived_v2" : "legacy_1to1";
}

/**
 * Validate every claimed line id against the order, under the order's
 * advisory lock. Throws LineIdentityError (→ HTTP 400) on any violation.
 * No-op when the payload claims no line ids (legacy callers).
 */
export async function validateLineIdentity(
  em: TxManager,
  orderId: string,
  items: LineIdentityItem[]
): Promise<void> {
  const claimed = items.filter(
    (it): it is LineIdentityItem & { order_line_item_id: string } =>
      Boolean(it.order_line_item_id)
  );
  if (!claimed.length) return;

  // Requested units per line (an invoice may repeat a line — sum them).
  const requested = new Map<string, number>();
  for (const it of claimed) {
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
      throw new LineIdentityError(
        "INVALID_LINE_QUANTITY",
        `Line "${it.description ?? it.order_line_item_id}" has a non-positive quantity (${it.quantity})`
      );
    }
    requested.set(
      it.order_line_item_id,
      (requested.get(it.order_line_item_id) ?? 0) + qty
    );
  }
  const lineIds = [...requested.keys()];

  // Serialize per order: concurrent invoice creates (and, in phase 2, the
  // dispatch assignment) contend on the same key. xact-scoped → auto-released.
  await em.execute(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
    `invoice-line-claim:${orderId}`,
  ]);

  // Ordered quantity per claimed line, from the order's CURRENT version
  // (edited orders leave stale order_item versions behind).
  const orderedRows = await em.execute<
    Array<{ id: string; ordered_qty: string | number }>
  >(
    `SELECT oli.id, oi.quantity::numeric AS ordered_qty
       FROM order_line_item oli
       JOIN order_item oi ON oi.item_id = oli.id
       JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
      WHERE oi.order_id = ?
        AND oli.id IN (${lineIds.map(() => "?").join(", ")})`,
    [orderId, ...lineIds]
  );
  const orderedByLine = new Map(
    (orderedRows ?? []).map((r) => [r.id, Number(r.ordered_qty)])
  );

  for (const lineId of lineIds) {
    if (!orderedByLine.has(lineId)) {
      throw new LineIdentityError(
        "INVALID_ORDER_LINE",
        `order_line_item_id ${lineId} does not belong to order ${orderId} (or is not on its current version)`
      );
    }
  }

  // Already-invoiced units per line across the order's ACTIVE invoices.
  const invoicedRows = await em.execute<
    Array<{ order_line_item_id: string; invoiced_qty: string | number }>
  >(
    `SELECT pii.order_line_item_id, SUM(pii.quantity)::numeric AS invoiced_qty
       FROM pos_invoice_item pii
       JOIN pos_invoice pi ON pi.id = pii.invoice_id
      WHERE pi.order_id = ?
        AND pi.status != 'voided'
        AND pii.order_line_item_id IN (${lineIds.map(() => "?").join(", ")})
      GROUP BY pii.order_line_item_id`,
    [orderId, ...lineIds]
  );
  const invoicedByLine = new Map(
    (invoicedRows ?? []).map((r) => [
      r.order_line_item_id,
      Number(r.invoiced_qty),
    ])
  );

  for (const [lineId, qty] of requested) {
    const ordered = orderedByLine.get(lineId) ?? 0;
    const alreadyInvoiced = invoicedByLine.get(lineId) ?? 0;
    if (alreadyInvoiced + qty > ordered) {
      throw new LineIdentityError(
        "OVER_INVOICE",
        `Line ${lineId}: invoicing ${qty} would exceed the order (ordered ${ordered}, already invoiced ${alreadyInvoiced})`
      );
    }
  }
}
