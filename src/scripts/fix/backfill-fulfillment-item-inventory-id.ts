/**
 * Backfill fulfillment_item.inventory_item_id for unshipped fulfillments.
 *
 * Root cause: the fallback `createFulfillment` paths in `complete-pickup` and
 * `create-fulfillment-force` created fulfillment items WITHOUT inventory_item_id.
 * When such a fulfillment is later shipped (native createOrderShipmentWorkflow →
 * prepareRegisterShipmentData), Medusa does
 *   iitems.find(i => i.inventory.id === fitem.inventory_item_id) // null → undefined
 *   quantity = div(quantity, undefined.required_quantity)         // TypeError
 * → generic 500 "An unknown error occurred." This blocked adding delivery tracking
 * to store-pickup orders (e.g. order 2212 / display_id 2212).
 *
 * This script sets inventory_item_id from the variant→inventory link for any
 * unshipped, non-canceled fulfillment item that is still NULL. Idempotent.
 *
 * Run: env DATABASE_URL=... npx medusa exec src/scripts/fix/backfill-fulfillment-item-inventory-id.ts
 */
export default async function ({ container }: { container: any }) {
  const knex = container.resolve("__pg_connection__");

  const rows = await knex.raw(
    `
    WITH resolved AS (
      SELECT fi.id AS fitem_id,
             (
               SELECT pvii.inventory_item_id
               FROM product_variant_inventory_item pvii
               WHERE pvii.variant_id = oli.variant_id
                 AND pvii.deleted_at IS NULL
               LIMIT 1
             ) AS inv_id
      FROM fulfillment_item fi
      JOIN fulfillment f ON f.id = fi.fulfillment_id
      JOIN order_line_item oli ON oli.id = fi.line_item_id
      WHERE fi.inventory_item_id IS NULL
        AND f.shipped_at IS NULL
        AND f.canceled_at IS NULL
        AND oli.variant_id IS NOT NULL
    )
    UPDATE fulfillment_item fi
    SET inventory_item_id = resolved.inv_id, updated_at = now()
    FROM resolved
    WHERE fi.id = resolved.fitem_id
      AND resolved.inv_id IS NOT NULL
    RETURNING fi.id, fi.fulfillment_id, fi.inventory_item_id;
    `
  );

  const updated = rows?.rows ?? [];
  console.log(`[backfill] updated ${updated.length} fulfillment_item rows`);
  const byFulfillment = new Set(updated.map((r: any) => r.fulfillment_id));
  console.log(`[backfill] across ${byFulfillment.size} fulfillments`);
  for (const r of updated) {
    console.log(`  ${r.id}  ful=${r.fulfillment_id}  inv=${r.inventory_item_id}`);
  }
}
