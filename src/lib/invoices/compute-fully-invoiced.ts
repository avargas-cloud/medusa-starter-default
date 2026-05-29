/**
 * Computes whether an order is "fully invoiced" — i.e. every order line's
 * quantity is covered by the line items of its non-voided / non-draft
 * invoices.
 *
 * This MIRRORS the POS detail-view logic exactly
 * (store-pos/app/(pos)/orders/[id]/hooks/useOrderData.ts → totalInvoiced,
 *  useOrderDetail.ts:47 → isFullyInvoiced): invoice line items are pooled
 * and consumed FIFO so that duplicate-SKU order lines each match a distinct
 * invoice line instead of all collapsing onto the first one.
 *
 * Used to drive the persisted `order.metadata.fully_invoiced` flag, which the
 * Meili `is_separated` derivation and the POS /orders tab/badge read so that a
 * separated (layaway) order drops out of the "Separated" view once it has been
 * completely billed — matching the rule that it is no longer an open order.
 */

export interface OrderLineForInvoiceMatch {
  quantity: number;
  variant_id?: string | null;
  /** Snapshot SKU on the order line, with variant.sku as fallback. */
  variant_sku?: string | null;
}

export interface InvoiceItemForMatch {
  variant_id?: string | null;
  sku?: string | null;
  quantity: number;
}

/**
 * @returns true only when there is at least one order line AND every line is
 * fully covered by matching invoice items. An order with no lines is never
 * considered fully invoiced (mirrors `items.length > 0` in the UI helper).
 */
export function computeFullyInvoiced(
  orderItems: ReadonlyArray<OrderLineForInvoiceMatch>,
  invoiceItems: ReadonlyArray<InvoiceItemForMatch>
): boolean {
  if (orderItems.length === 0) return false;

  // Mutable working copy of the pool — we never touch the caller's arrays.
  const pool = invoiceItems.map((it) => ({
    variant_id: it.variant_id ?? null,
    sku: it.sku ?? null,
    remaining: it.quantity,
  }));

  return orderItems.every((line) => {
    let totalInvoiced = 0;
    while (totalInvoiced < line.quantity) {
      const idx = pool.findIndex(
        (inv) =>
          inv.remaining > 0 &&
          ((!!line.variant_id && inv.variant_id === line.variant_id) ||
            (!!line.variant_sku && inv.sku === line.variant_sku))
      );
      const matched = idx === -1 ? undefined : pool[idx];
      if (!matched) break;
      totalInvoiced += matched.remaining;
      matched.remaining = 0;
    }
    return totalInvoiced >= line.quantity;
  });
}
