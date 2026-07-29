import type { MedusaContainer } from "@medusajs/framework/types";

import { buildOrderDoc, type OrderForMeili } from "./build-order-doc";
import { enrichOrderTotals } from "./enrich-order-totals";

export const ORDERS_INDEX = "orders";

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "is_draft_order",
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
  // Needed so buildOrderDoc can compute fulfillment_status locally —
  // query.graph silently drops the top-level fulfillment_status field.
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.delivered_at",
  "fulfillments.canceled_at",
  // Line-item fulfilled qty — lets computeFulfillmentStatus demote a
  // fully-delivered fulfillment set to partially_delivered when some line
  // items were never fulfilled (mirrors Medusa's hasUnfulfilledItems guard).
  "items.quantity",
  "items.detail.fulfilled_quantity",
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

  // Deterministic enrichment. Under bulk load, query.graph intermittently
  // returns fulfillments=[] (link race) or stale items.detail.fulfilled_quantity,
  // which makes computeFulfillmentStatus mislabel a fully-delivered order as
  // "partially_delivered" and strand it in the Open tab (e.g. S10374). Override
  // both fulfillments and current-version line quantities from authoritative SQL
  // so the reindex is race-free.
  try {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const [fulRes, itemRes] = await Promise.all([
      db.query(
        `SELECT ofu.order_id, f.packed_at, f.shipped_at, f.delivered_at, f.canceled_at
           FROM order_fulfillment ofu
           JOIN fulfillment f ON f.id = ofu.fulfillment_id
          WHERE ofu.deleted_at IS NULL AND f.deleted_at IS NULL`
      ),
      db.query(
        `SELECT oi.order_id, oi.quantity, oi.fulfilled_quantity
           FROM order_item oi
           JOIN "order" o ON o.id = oi.order_id AND o.version = oi.version`
      ),
    ]);

    // The order total is missing from query.graph too — same gap, same fix.
    // Must happen before db.end(), and before buildOrderDoc: every payment
    // branch downstream is gated on a positive total.
    const totals = await enrichOrderTotals(db, orders as any[]);
    await db.end();

    if (totals.patched > 0) {
      log.info(
        `[sync-meili-orders] SQL-enriched totals for ${totals.patched} orders`
      );
    }
    if (totals.unresolved.length > 0) {
      log.warn?.(
        `[sync-meili-orders] ${totals.unresolved.length} order(s) still have no ` +
          `resolvable total and will index with 0 — they land in no payment ` +
          `bucket: ${totals.unresolved.slice(0, 10).join(", ")}`
      );
    }

    const fulByOrder = new Map<string, unknown[]>();
    for (const r of fulRes.rows) {
      const list = fulByOrder.get(r.order_id) ?? [];
      list.push(r);
      fulByOrder.set(r.order_id, list);
    }
    const itemsByOrder = new Map<string, unknown[]>();
    for (const r of itemRes.rows) {
      const list = itemsByOrder.get(r.order_id) ?? [];
      list.push({
        quantity: r.quantity,
        detail: { fulfilled_quantity: r.fulfilled_quantity },
      });
      itemsByOrder.set(r.order_id, list);
    }
    for (const o of orders as any[]) {
      o.fulfillments = fulByOrder.get(o.id) ?? [];
      const items = itemsByOrder.get(o.id);
      if (items) o.items = items;
    }
    log.info(
      `[sync-meili-orders] SQL-enriched fulfillments/items for ${orders.length} orders`
    );
  } catch (sqlErr: any) {
    (log.warn ?? log.info)(
      `[sync-meili-orders] SQL enrichment skipped (using query.graph data): ${sqlErr?.message}`
    );
  }

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
      "is_draft",
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
