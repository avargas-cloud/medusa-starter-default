import type { MedusaContainer } from "@medusajs/framework/types";

import { ORDER_AUDITED_FIELDS } from "../orders-audited-fields";
import type { EntityReconciler } from "../drift-reconciler";
import { ORDERS_INDEX, buildAllOrderDocs } from "../sync-orders-runner";

/**
 * Keeps the `orders` index honest without any route having to remember anything.
 *
 * Until this existed, orders were the only important entity whose sync depended
 * entirely on an event being emitted. Products, variants, customers, inventory
 * levels, reservations, vendors, POs and FOs all had a Postgres trigger feeding
 * meili_sync_queue and a reconciler draining it; orders had neither. On
 * 2026-07-29 that gap produced ~900 wrong documents — a finance route moved money
 * and emitted nothing — and nothing anywhere noticed until the operator did.
 *
 * Everything routes through buildAllOrderDocs, the same construction the full
 * reindex uses. A second fetch/enrich path here would drift away from that one,
 * which is precisely the failure mode being fixed.
 *
 * Measured before shipping: ~19 distinct orders change per day, ~254 queue rows,
 * against 47,785 already accumulated across the other entities. The queue
 * processor dedups by entity id when it drains, so repeated line edits on one
 * order cost queue rows, not repeated Meili writes.
 */

async function buildOneOrderDoc(
  id: string,
  container: MedusaContainer
): Promise<Record<string, unknown> | null> {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const [doc] = await buildAllOrderDocs(container, silent, [id]);
  return (doc as unknown as Record<string, unknown>) ?? null;
}

export const orderReconciler: EntityReconciler = {
  entityType: "order",
  meiliIndex: ORDERS_INDEX,
  // Shared with the daily audit on purpose. When this list and the audit's were
  // two separate literals they had already diverged by three fields, which means
  // the 5-minute sweep and the report disagreed about what "drifted" meant.
  comparableFields: [...ORDER_AUDITED_FIELDS],
  buildExpectedDoc: buildOneOrderDoc,
  syncOne: async (id, container) => {
    const doc = await buildOneOrderDoc(id, container);

    const { MeiliSearch } = await import("meilisearch");
    const index = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    }).index(ORDERS_INDEX);

    if (!doc) {
      // The order is gone from the DB, so the document should go too. Unlike
      // inventory_level — where the row is a component of a doc — an `order` row
      // IS the document.
      await index.deleteDocument(id);
      return;
    }
    await index.updateDocuments([doc], { primaryKey: "id" });
  },
  fetchUpdatedIdsSince: async (sql, sinceIso, limit) => {
    // Every table the doc reads from, not just `order`: a captured payment or a
    // delivered fulfillment changes the doc while leaving order.updated_at alone,
    // and that is exactly the drift this catches.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM (
        SELECT o.id, o.updated_at FROM "order" o
         WHERE o.deleted_at IS NULL AND o.updated_at >= ${sinceIso}
        UNION
        SELECT s.order_id AS id, s.updated_at FROM order_summary s
         WHERE s.deleted_at IS NULL AND s.updated_at >= ${sinceIso}
        UNION
        SELECT oi.order_id AS id, oi.updated_at FROM order_item oi
         WHERE oi.deleted_at IS NULL AND oi.updated_at >= ${sinceIso}
        UNION
        SELECT opc.order_id AS id, pc.updated_at
          FROM order_payment_collection opc
          JOIN payment_collection pc ON pc.id = opc.payment_collection_id
         WHERE opc.deleted_at IS NULL AND pc.deleted_at IS NULL
           AND pc.updated_at >= ${sinceIso}
        UNION
        SELECT ofu.order_id AS id, f.updated_at
          FROM order_fulfillment ofu
          JOIN fulfillment f ON f.id = ofu.fulfillment_id
         WHERE ofu.deleted_at IS NULL AND f.deleted_at IS NULL
           AND f.updated_at >= ${sinceIso}
      ) touched
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },
};
