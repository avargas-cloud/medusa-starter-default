import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";

import {
  buildPosInvoiceDoc,
  type CustomerRefForMeili,
  type OrderRefForMeili,
  type PosInvoiceForMeili,
} from "./build-pos-invoice-doc";

export const POS_INVOICES_INDEX = "pos_invoices";

export interface SyncResult {
  synced: number;
  total: number;
}

interface MinimalLogger {
  info: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
}

/**
 * Reads every pos_invoice from the DB, denormalizes the linked order +
 * customer, and upserts the flat docs into the `pos_invoices` Meili index.
 * Self-applies index settings so it's safe on a fresh install too.
 *
 * Used by the CLI script and the admin recovery endpoint.
 */
export async function syncAllPosInvoicesToMeili(
  container: MedusaContainer,
  logger?: MinimalLogger
): Promise<SyncResult> {
  const log: MinimalLogger = logger ?? (container.resolve("logger") as any);
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const customerModule = container.resolve(Modules.CUSTOMER);
  const query = container.resolve("query") as any;

  log.info("[sync-meili-pos-invoices] Fetching all invoices…");
  const invoices: PosInvoiceForMeili[] = await invoiceService.listPosInvoices(
    {},
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
      take: null as any,
    }
  );
  log.info(`[sync-meili-pos-invoices] Loaded ${invoices.length} invoices`);

  const orderIds = [
    ...new Set(invoices.map((i) => i.order_id).filter(Boolean)),
  ];
  const customerIds = [
    ...new Set(invoices.map((i) => i.customer_id).filter(Boolean)),
  ];

  const ordersById = new Map<string, OrderRefForMeili>();
  if (orderIds.length > 0) {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "display_id", "metadata"],
      filters: { id: orderIds },
    });
    for (const o of orders || []) {
      ordersById.set(o.id, {
        display_id: o.display_id ?? null,
        metadata: o.metadata ?? null,
      });
    }
  }

  const customersById = new Map<string, CustomerRefForMeili>();
  if (customerIds.length > 0) {
    const customers = await customerModule.listCustomers(
      { id: customerIds },
      {
        select: [
          "id",
          "first_name",
          "last_name",
          "email",
          "phone",
          "company_name",
        ],
      }
    );
    for (const c of customers || []) {
      customersById.set(c.id, {
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        company_name: (c as any).company_name,
      });
    }
  }

  const docs = invoices.map((inv) =>
    buildPosInvoiceDoc(
      inv,
      ordersById.get(inv.order_id) ?? null,
      customersById.get(inv.customer_id) ?? null
    )
  );

  const { MeiliSearch } = await import("meilisearch");
  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });

  try {
    await client.getIndex(POS_INVOICES_INDEX);
  } catch {
    log.info(
      `[sync-meili-pos-invoices] Creating index "${POS_INVOICES_INDEX}"`
    );
    await client.createIndex(POS_INVOICES_INDEX, { primaryKey: "id" });
  }

  const index = client.index(POS_INVOICES_INDEX);

  await index.updateSettings({
    searchableAttributes: [
      "invoice_number",
      "invoice_number_str",
      "order_display_id_str",
      "order_document_number",
      "customer_name",
      "customer_email",
      "customer_phone",
      "customer_phone_digits",
      "company_name",
      "qb_invoice_ref",
      "payment_method",
      "notes",
    ],
    filterableAttributes: [
      "status",
      "payment_method",
      "card_brand",
      "has_balance",
    ],
    sortableAttributes: [
      "invoice_number",
      "created_at_ts",
      "total_cents",
      "balance_cents",
    ],
  });

  const CHUNK = 500;
  let synced = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    await index.updateDocuments(chunk, { primaryKey: "id" });
    synced += chunk.length;
    log.info(`[sync-meili-pos-invoices] ${synced}/${docs.length}`);
  }

  log.info(
    `[sync-meili-pos-invoices] ✅ Done — ${synced} invoices sent to MeiliSearch.`
  );

  return { synced, total: invoices.length };
}
