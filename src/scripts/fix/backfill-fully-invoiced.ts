/**
 * Backfills the persisted `metadata.fully_invoiced` flag on every separated
 * (layaway) order, then reindexes it to MeiliSearch.
 *
 * WHY: `fully_invoiced` is normally maintained by the order Meili sync
 * subscriber on invoice / order-edit events. Orders that were already fully
 * invoiced before that subscriber existed never got the flag, so they keep
 * showing up under the POS /orders "Separated" tab even though they're no
 * longer open. This one-shot stamps them so they drop out.
 *
 * Only separated orders are touched — the flag is irrelevant for the rest.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/fix/backfill-fully-invoiced.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { buildOrderDoc, type OrderForMeili } from "../../lib/meilisearch/build-order-doc";
import { loadFullyInvoicedForOrder } from "../../lib/invoices/load-fully-invoiced";

const ORDERS_INDEX = "orders";

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
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.delivered_at",
  "fulfillments.canceled_at",
];

export default async function backfillFullyInvoiced({
  container,
}: ExecArgs): Promise<void> {
  const query = container.resolve("query");
  const orderModule = container.resolve(Modules.ORDER);

  // Pull every order's id + metadata; filter to separated client-side
  // (metadata.is_separated is JSON, not a queryable column).
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "metadata"],
    pagination: { take: null },
  });

  const separated = (orders ?? []).filter(
    (o: any) => o?.metadata?.is_separated === true
  );

  console.log(
    `[backfill-fully-invoiced] ${separated.length} separated order(s) to evaluate`
  );

  const changedIds: string[] = [];
  for (const o of separated) {
    try {
      const fullyInvoiced = await loadFullyInvoicedForOrder(o.id, container);
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      if (meta.fully_invoiced === fullyInvoiced) continue;

      await orderModule.updateOrders(o.id, {
        metadata: { ...meta, fully_invoiced: fullyInvoiced },
      });
      changedIds.push(o.id);
      console.log(
        `[backfill-fully-invoiced] order ${o.id} fully_invoiced → ${fullyInvoiced}`
      );
    } catch (err: unknown) {
      console.log(
        `[backfill-fully-invoiced] ❌ ${o.id}: ${(err as Error).message}`
      );
    }
  }

  if (changedIds.length === 0) {
    console.log("[backfill-fully-invoiced] Nothing to reindex. Done.");
    return;
  }

  // Reindex the touched orders so the Separated tab/count reflect the change.
  const { data: fresh } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    filters: { id: changedIds },
  });
  const docs = (fresh as OrderForMeili[]).map((o) => buildOrderDoc(o));

  const { MeiliSearch } = await import("meilisearch");
  const meili = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
  await meili.index(ORDERS_INDEX).updateDocuments(docs, { primaryKey: "id" });

  console.log(
    `[backfill-fully-invoiced] ✅ stamped + reindexed ${changedIds.length} order(s).`
  );
}
