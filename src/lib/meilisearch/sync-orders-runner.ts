import type { MedusaContainer } from "@medusajs/framework/types";

import { buildOrderDoc, type OrderForMeili } from "./build-order-doc";

export const ORDERS_INDEX = "orders";

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "payment_status",
  "fulfillment_status",
  "email",
  "total",
  "canceled_at",
  "created_at",
  "updated_at",
  "metadata",
  "summary.current_order_total",
  "payment_collections.captured_amount",
  "payment_collections.refunded_amount",
  "customer.first_name",
  "customer.last_name",
  "customer.email",
  "customer.phone",
  "customer.company_name",
  "billing_address.company",
  "billing_address.phone",
  "shipping_address.company",
  "shipping_address.phone",
  "sales_channel.id",
  "sales_channel.name",
];

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
 * Reads every order from the DB, builds the flat Meili doc, and upserts
 * into the `orders` index. Idempotent. Self-applies index settings so it
 * works on a fresh Meili install too.
 *
 * Used both by the CLI script (scripts/sync/sync-meili-orders.ts) and
 * the admin recovery endpoint (api/admin/search/orders/sync).
 */
export async function syncAllOrdersToMeili(
  container: MedusaContainer,
  logger?: MinimalLogger
): Promise<SyncResult> {
  const log: MinimalLogger = logger ?? (container.resolve("logger") as any);
  const query = container.resolve("query") as any;

  log.info("[sync-meili-orders] Fetching all orders…");
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    pagination: { take: null },
  });

  log.info(`[sync-meili-orders] Loaded ${orders.length} orders`);

  const docs = (orders as OrderForMeili[]).map((o) => buildOrderDoc(o));

  const { MeiliSearch } = await import("meilisearch");
  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });

  try {
    await client.getIndex(ORDERS_INDEX);
  } catch {
    log.info(`[sync-meili-orders] Creating index "${ORDERS_INDEX}"`);
    await client.createIndex(ORDERS_INDEX, { primaryKey: "id" });
  }

  const index = client.index(ORDERS_INDEX);

  await index.updateSettings({
    searchableAttributes: [
      "document_number",
      "display_id_str",
      "customer_name",
      "customer_email",
      "customer_phone",
      "customer_phone_digits",
      "company_name",
      "qb_sales_order_ref",
      "qb_invoice_refs",
    ],
    filterableAttributes: [
      "status",
      "payment_status",
      "fulfillment_status",
      "effective_payment",
      "is_unpaid",
      "is_open",
      "is_closed",
      "is_separated",
      "is_canceled",
      "is_voided",
      "is_web",
      "is_web_order",
      "sales_rep_initials",
      "sales_channel_id",
      "created_at_ts",
      "effective_date_ts",
    ],
    sortableAttributes: [
      "display_id",
      "created_at_ts",
      "effective_date_ts",
      "total_cents",
    ],
  });

  const CHUNK = 500;
  let synced = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    await index.updateDocuments(chunk, { primaryKey: "id" });
    synced += chunk.length;
    log.info(`[sync-meili-orders] ${synced}/${docs.length}`);
  }

  log.info(
    `[sync-meili-orders] ✅ Done — ${synced} orders sent to MeiliSearch (async task running).`
  );

  return { synced, total: orders.length };
}
