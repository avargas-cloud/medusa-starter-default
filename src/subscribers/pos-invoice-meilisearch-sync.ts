import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import {
  buildPosInvoiceDoc,
  type CustomerRefForMeili,
  type OrderRefForMeili,
  type PosInvoiceForMeili,
} from "../lib/meilisearch/build-pos-invoice-doc";
import { INVOICE_MODULE } from "../modules/invoices";

/**
 * AUTO-SYNC POS INVOICE → MEILISEARCH
 *
 * Keeps the `pos_invoices` index in step with the database for the POS
 * /invoices search bar. Doc shape lives in
 * lib/meilisearch/build-pos-invoice-doc.ts.
 *
 * Events handled:
 *   • pos.invoice.created  — new invoice issued
 *   • pos.invoice.voided   — status flipped to voided
 *   • pos.payment.applied / .voided / .unapplied
 *       → balance changed, re-sync the affected invoice(s)
 *   • order.updated        — order metadata.document_number can change;
 *                            re-sync the invoice(s) for that order
 *   • customer.updated     — re-sync invoices for that customer
 */

const POS_INVOICES_INDEX = "pos_invoices";

async function getMeili() {
  const { MeiliSearch } = await import("meilisearch");
  return new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
}

async function loadOrderRef(
  orderId: string,
  container: any
): Promise<OrderRefForMeili | null> {
  if (!orderId) return null;
  try {
    const query = container.resolve("query");
    const { data } = await query.graph({
      entity: "order",
      fields: ["display_id", "metadata"],
      filters: { id: orderId },
    });
    const o = (data || [])[0];
    return o
      ? { display_id: o.display_id ?? null, metadata: o.metadata ?? null }
      : null;
  } catch {
    return null;
  }
}

async function loadCustomerRef(
  customerId: string,
  container: any
): Promise<CustomerRefForMeili | null> {
  if (!customerId) return null;
  try {
    const customerModule = container.resolve(Modules.CUSTOMER);
    const c = await customerModule.retrieveCustomer(customerId);
    return c
      ? {
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone,
          company_name: (c as any).company_name,
        }
      : null;
  } catch {
    return null;
  }
}

async function syncInvoices(
  invoiceIds: string[],
  container: any,
  logger: any
): Promise<void> {
  if (invoiceIds.length === 0) return;

  try {
    const invoiceService = container.resolve(INVOICE_MODULE) as any;
    const invoices: PosInvoiceForMeili[] =
      await invoiceService.listPosInvoices(
        { id: invoiceIds },
        {
          select: [
            "id",
            "invoice_number",
            "order_id",
            "customer_id",
            "status",
            "payment_method",
            "card_brand",
            "notes",
            "total",
            "amount_paid",
            "balance_due",
            "voided_at",
            "created_at",
            "updated_at",
          ],
        }
      );

    if (!invoices || invoices.length === 0) {
      logger.warn(
        `[MEILI-INVOICE-SYNC] no invoices returned for ids: ${invoiceIds.join(",")}`
      );
      return;
    }

    const docs = await Promise.all(
      invoices.map(async (inv) => {
        const [order, customer] = await Promise.all([
          loadOrderRef(inv.order_id, container),
          loadCustomerRef(inv.customer_id, container),
        ]);
        return buildPosInvoiceDoc(inv, order, customer);
      })
    );

    const meili = await getMeili();
    await meili
      .index(POS_INVOICES_INDEX)
      .updateDocuments(docs, { primaryKey: "id" });

    logger.info(
      `[MEILI-INVOICE-SYNC] ✅ upserted ${docs.length} invoice doc${
        docs.length === 1 ? "" : "s"
      } (${docs.map((d) => `#${d.invoice_number}`).join(", ")})`
    );
  } catch (err: any) {
    logger.error(
      `[MEILI-INVOICE-SYNC] ❌ sync failed for [${invoiceIds.join(",")}]: ${
        err?.message
      }`
    );
  }
}

async function syncInvoicesForOrder(
  orderId: string,
  container: any,
  logger: any
): Promise<void> {
  if (!orderId) return;
  try {
    const invoiceService = container.resolve(INVOICE_MODULE) as any;
    const list: Array<{ id: string }> = await invoiceService.listPosInvoices(
      { order_id: orderId },
      { select: ["id"] }
    );
    const ids = list.map((i) => i.id).filter(Boolean);
    if (ids.length === 0) return;
    await syncInvoices(ids, container, logger);
  } catch (err: any) {
    logger.warn(
      `[MEILI-INVOICE-SYNC] ⚠️ order cascade failed for ${orderId}: ${err?.message}`
    );
  }
}

async function syncInvoicesForCustomer(
  customerId: string,
  container: any,
  logger: any
): Promise<void> {
  if (!customerId) return;
  try {
    const invoiceService = container.resolve(INVOICE_MODULE) as any;
    const list: Array<{ id: string }> = await invoiceService.listPosInvoices(
      { customer_id: customerId },
      { select: ["id"] }
    );
    const ids = list.map((i) => i.id).filter(Boolean);
    if (ids.length === 0) return;
    logger.info(
      `[MEILI-INVOICE-SYNC] cascading customer ${customerId} → ${ids.length} invoice(s)`
    );
    await syncInvoices(ids, container, logger);
  } catch (err: any) {
    logger.warn(
      `[MEILI-INVOICE-SYNC] ⚠️ customer cascade failed for ${customerId}: ${err?.message}`
    );
  }
}

function extractIds(data: unknown): string[] {
  if (!data) return [];
  if (typeof data === "string") return [data];
  if (Array.isArray(data)) {
    return data
      .map((d) =>
        typeof d === "string"
          ? d
          : typeof d?.id === "string"
            ? d.id
            : typeof d?.invoice_id === "string"
              ? d.invoice_id
              : ""
      )
      .filter((s): s is string => !!s);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const id = obj.id ?? obj.invoice_id;
    if (typeof id === "string") return [id];
    if (Array.isArray(id))
      return (id as unknown[]).filter(
        (s: unknown): s is string => typeof s === "string"
      );
  }
  return [];
}

function extractOrderId(data: unknown): string | null {
  if (!data) return null;
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.order_id === "string") return obj.order_id;
  }
  return null;
}

export default async function posInvoiceMeilisearchSubscriber({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve("logger");

  // Cascades from related entities
  if (event.name === "customer.updated") {
    const customerIds = extractIds(event.data);
    for (const cid of customerIds) {
      await syncInvoicesForCustomer(cid, container, logger);
    }
    return;
  }

  if (event.name === "order.updated") {
    const orderIds = extractIds(event.data);
    for (const oid of orderIds) {
      await syncInvoicesForOrder(oid, container, logger);
    }
    return;
  }

  // Direct invoice events
  if (event.name === "pos.invoice.created" || event.name === "pos.invoice.voided") {
    const ids = extractIds(event.data);
    if (ids.length > 0) {
      await syncInvoices(ids, container, logger);
      return;
    }
    // Fall back to order_id when payload only carries that
    const orderId = extractOrderId(event.data);
    if (orderId) await syncInvoicesForOrder(orderId, container, logger);
    return;
  }

  // Payment lifecycle — affects balance_due → re-sync the related invoice(s).
  // Payload usually carries application/payment ids; we resolve to invoice
  // via order_id if present, else skip.
  if (
    event.name === "pos.payment.applied" ||
    event.name === "pos.payment.voided" ||
    event.name === "pos.payment.unapplied"
  ) {
    const orderId = extractOrderId(event.data);
    if (orderId) {
      await syncInvoicesForOrder(orderId, container, logger);
      return;
    }
    // Direct invoice_id payload (newer applications carry it)
    const ids = extractIds(event.data);
    if (ids.length > 0) await syncInvoices(ids, container, logger);
    return;
  }

  logger.warn(
    `[MEILI-INVOICE-SYNC] unhandled event: ${event.name} — ignoring`
  );
}

export const config: SubscriberConfig = {
  event: [
    "pos.invoice.created",
    "pos.invoice.voided",
    "pos.payment.applied",
    "pos.payment.voided",
    "pos.payment.unapplied",
    "order.updated",
    "customer.updated",
  ],
};
