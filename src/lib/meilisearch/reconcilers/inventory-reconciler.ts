import { Modules } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { EntityReconciler } from "../drift-reconciler";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../workflows/sync-inventory-item-meilisearch";
import { USA_LOC } from "../../locations";

/**
 * Reconciler for the MeiliSearch `inventory` index.
 *
 * Why this exists: the `inventory` index is the highest-churn index in the
 * system — every sale, reservation, fulfillment, receipt and count moves
 * stock — yet it was the ONLY core index never wired into the 3-tier sync
 * system (the cron + queue only knew `customer` and `product`). A stock
 * change bumps neither `product.updated_at` nor `product_variant.updated_at`,
 * so the product reconciler never noticed inventory-only drift and the index
 * silently went stale (some docs un-synced for months).
 *
 * The Meili doc id is the `inventory_item.id` (== `inventory_level.inventory_item_id`).
 * The volatile, drift-prone fields are the Miami (USA_LOC) stock numbers, which
 * is exactly what `build-inventory-docs.ts` writes:
 *   totalStock    = Miami inventory_level.stocked_quantity
 *   totalReserved = Miami inventory_level.reserved_quantity
 *
 * NOTE: `totalReserved` mirrors the cached `inventory_level.reserved_quantity`,
 * NOT `SUM(reservation_item.quantity)`. If that cache itself is corrupt, this
 * reconciler faithfully republishes the corrupt value — repairing the cache is
 * the job of the separate reservation-integrity audit, not of Meili sync.
 */
async function buildExpectedInventoryDoc(
  inventoryItemId: string,
  container: MedusaContainer
): Promise<Record<string, unknown> | null> {
  const inventoryService = container.resolve(Modules.INVENTORY) as {
    listInventoryLevels: (
      filters: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<
      Array<{
        inventory_item_id: string;
        stocked_quantity?: number;
        reserved_quantity?: number;
      }>
    >;
  };

  const levels = await inventoryService.listInventoryLevels(
    { location_id: USA_LOC, inventory_item_id: inventoryItemId },
    { take: 1 }
  );

  // No Miami level → item doesn't exist, or is China-only. We skip it here
  // (return null) rather than emit {totalStock:0} which would cause perpetual
  // false-drift against a legitimate China-based doc. China-only items are
  // still kept fresh by the PRIMARY mechanism — the inventory_level trigger
  // enqueues on ANY location change (incl. China) → the 1-min queue processor
  // rebuilds the full doc via syncOne. This cron is only the Miami safety net.
  const level = levels?.[0];
  if (!level) return null;

  return {
    id: inventoryItemId,
    totalStock: level.stocked_quantity ?? 0,
    totalReserved: level.reserved_quantity ?? 0,
  };
}

export const inventoryReconciler: EntityReconciler = {
  // Matches the entity_type enqueued by the inventory_level Postgres trigger
  // and the key registered in the queue processor's RECONCILERS map.
  entityType: "inventory_item",
  meiliIndex: "inventory",
  comparableFields: ["totalStock", "totalReserved"],
  buildExpectedDoc: buildExpectedInventoryDoc,
  syncOne: async (id, container) => {
    // Delegate to the canonical single-item workflow so the doc is rebuilt
    // identically to every other write path (price lists, China stock, etc.).
    await syncInventoryItemToMeiliSearchWorkflow(container).run({
      input: { inventoryItemId: id },
    });
  },
  fetchUpdatedIdsSince: async (sql, sinceIso, limit) => {
    // Any inventory_level row touched since `sinceIso` is a candidate. We
    // don't filter by location here: a China-level change still warrants a
    // full doc rebuild (chinaStock), and buildExpectedDoc/diff is cheap and
    // no-ops when the Miami numbers already match.
    const rows = await sql<{ inventory_item_id: string }[]>`
      SELECT DISTINCT inventory_item_id
      FROM inventory_level
      WHERE updated_at >= ${sinceIso}
        AND inventory_item_id IS NOT NULL
      ORDER BY inventory_item_id
      LIMIT ${limit}
    `;
    return rows.map((r) => r.inventory_item_id);
  },
};
