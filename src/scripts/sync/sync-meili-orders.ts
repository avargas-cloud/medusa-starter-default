/**
 * Backfill the MeiliSearch `orders` index from every order in the database.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/sync/sync-meili-orders.ts
 *
 * Idempotent: safe to re-run. Each run upserts every order's flat doc.
 * The Meili task is asynchronous — index reflects new docs within seconds.
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import {
  buildOrderDoc,
  type OrderForMeili,
} from "../../lib/meilisearch/build-order-doc";

const ORDERS_INDEX = "orders";

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

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  const query = container.resolve("query") as any;

  logger.info("[sync-meili-orders] Fetching all orders…");
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    pagination: { take: null },
  });

  logger.info(`[sync-meili-orders] Loaded ${orders.length} orders`);

  const docs = (orders as OrderForMeili[]).map((o) => buildOrderDoc(o));

  const { MeiliSearch } = await import("meilisearch");
  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });

  // Ensure the index exists with the right primary key. Settings live in
  // medusa-config.ts and the plugin re-applies them on startup; we also
  // apply them here so the script is self-contained (covers fresh installs
  // and post-DELETE recoveries where the plugin hasn't re-run yet).
  try {
    await client.getIndex(ORDERS_INDEX);
  } catch {
    logger.info(`[sync-meili-orders] Creating index "${ORDERS_INDEX}"`);
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
      "is_canceled",
      "is_voided",
      "is_web_order",
      "sales_rep_initials",
      "sales_channel_id",
    ],
    sortableAttributes: ["display_id", "created_at_ts", "total_cents"],
  });

  const CHUNK = 500;
  let synced = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    // Pass primaryKey explicitly — Meili refuses to infer it because the
    // doc has both `id` and `display_id` (two fields ending in "id").
    await index.updateDocuments(chunk, { primaryKey: "id" });
    synced += chunk.length;
    logger.info(`[sync-meili-orders] ${synced}/${docs.length}`);
  }

  logger.info(
    `[sync-meili-orders] ✅ Done — ${synced} orders sent to MeiliSearch (async task running).`
  );
}
