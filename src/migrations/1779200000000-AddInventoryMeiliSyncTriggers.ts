import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Extend the Capa-2 meili sync trigger setup to `inventory_level` — the
 * highest-churn stock table and the ONE core index that was never wired into
 * the 3-tier MeiliSearch sync system.
 *
 * Every stock movement (sale → reservation, fulfillment, return, receipt,
 * count, transfer, raw SQL fix) ultimately UPDATEs `inventory_level`. A row
 * trigger here fires regardless of the writer (Medusa core workflows, custom
 * routes, psql, fix scripts) and enqueues the affected `inventory_item_id` so
 * the `meili-sync-queue-processor` (entity_type 'inventory_item' →
 * inventoryReconciler) rebuilds the doc within ~1 minute. This closes the gaps
 * the per-callsite `syncInventoryItemToMeiliSearchWorkflow` calls left open
 * (order placement, invoice create/void, manual allocation, force-fulfillment,
 * web checkout — none of which had an explicit sync).
 *
 * Design choices:
 *  - entity_id = inventory_item_id (the Meili doc id), NOT inventory_level.id,
 *    so a dedicated trigger function is required (the generic
 *    enqueue_meili_sync uses NEW.id).
 *  - op is ALWAYS 'UPDATE' (never 'DELETE'): deleting a level/row must trigger
 *    a re-sync of the item's CURRENT state, not a delete of the whole inventory
 *    doc (the item still exists with other levels). The queue processor only
 *    deletes docs on op='DELETE'; we never want that here. True item deletion
 *    is handled by the product.deleted subscriber (deleteWhenMissing) and the
 *    full-resync orphan cleanup.
 *
 * IMPORTANT (atomic ship): this migration MUST deploy together with the
 * `inventory_item` registration in meili-sync-queue-processor.ts RECONCILERS.
 * If the trigger ships first, enqueued rows get marked "no reconciler
 * registered" and are lost.
 */
export class AddInventoryMeiliSyncTriggers1779200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Trigger function: enqueue the inventory_item_id of the changed level.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_sync_inventory_item() RETURNS TRIGGER AS $$
      DECLARE
        target_item_id TEXT;
      BEGIN
        target_item_id := COALESCE(NEW.inventory_item_id, OLD.inventory_item_id);
        IF target_item_id IS NULL THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        VALUES (
          'inventory_item',
          target_item_id,
          'UPDATE',
          current_setting('application_name', true)
        );
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_inventory_level ON inventory_level
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_inventory_level
      AFTER INSERT OR UPDATE OR DELETE ON inventory_level
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync_inventory_item()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_inventory_level ON inventory_level`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_sync_inventory_item()`
    );
  }
}
