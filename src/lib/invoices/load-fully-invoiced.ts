/**
 * Loads an order's line items and its non-voided / non-draft invoices, then
 * computes whether the order is fully invoiced (see compute-fully-invoiced.ts).
 *
 * Shared by the order Meili sync subscriber (on pos.invoice.created /
 * pos.invoice.voided) and the backfill script so the rule lives in one place.
 */

import { INVOICE_MODULE } from "../../modules/invoices";
import {
  computeFullyInvoiced,
  type InvoiceItemForMatch,
  type OrderLineForInvoiceMatch,
} from "./compute-fully-invoiced";

// Invoice statuses that do NOT count toward "invoiced" coverage. Mirrors the
// POS pool filter (`status !== 'voided' && status !== 'draft'`).
const NON_COUNTING_STATUSES = new Set(["voided", "draft"]);

export async function loadFullyInvoicedForOrder(
  orderId: string,
  container: { resolve: (key: string) => any }
): Promise<boolean> {
  const query = container.resolve("query");
  const invoiceService = container.resolve(INVOICE_MODULE);

  // query.graph traverses the variant link so we can fall back to variant.sku
  // exactly like the POS detail view (i.variant_sku || i.variant?.sku).
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "items.quantity",
      "items.variant_id",
      "items.variant_sku",
      "items.variant.sku",
    ],
    filters: { id: orderId },
  });
  const order = (data ?? [])[0];

  const orderItems: OrderLineForInvoiceMatch[] = (order?.items ?? []).map(
    (i: Record<string, any>) => ({
      quantity: Number(i.quantity ?? 0),
      variant_id: i.variant_id ?? null,
      variant_sku: i.variant_sku ?? i.variant?.sku ?? null,
    })
  );

  const invoices = await invoiceService.listPosInvoices(
    { order_id: orderId },
    { relations: ["items"] }
  );

  const invoiceItems: InvoiceItemForMatch[] = (invoices ?? [])
    .filter((inv: Record<string, any>) => !NON_COUNTING_STATUSES.has(inv.status))
    .flatMap((inv: Record<string, any>) => inv.items ?? [])
    .map((it: Record<string, any>) => ({
      variant_id: it.variant_id ?? null,
      sku: it.sku ?? null,
      quantity: Number(it.quantity ?? 0),
    }));

  return computeFullyInvoiced(orderItems, invoiceItems);
}
