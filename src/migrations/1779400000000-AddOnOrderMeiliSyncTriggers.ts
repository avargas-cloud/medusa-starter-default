import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wire PO/FO "on-order" into the MeiliSearch `inventory` index sync.
 *
 * The `inventory` Meili doc now carries `onOrderUsa` (open Purchase Orders —
 * always USA) and `onOrderChina` (open Factory Orders — always China). Those
 * numbers come from `purchase_order_line` / `factory_order_line`, NOT from
 * `inventory_level`, so the existing `inventory_level` trigger never refreshes
 * them. Add triggers so any qty/status change requeues the affected
 * inventory_item for the `meili-sync-queue-processor` (entity_type
 * 'inventory_item' → inventoryReconciler), which rebuilds the doc with the
 * current on-order balance within ~1 min.
 *
 * Two layers (writer-agnostic — fires for routes, workflows, scripts, raw SQL):
 *
 *  1. LINE triggers on `purchase_order_line` + `factory_order_line`.
 *     Both tables have a (100%-populated) `inventory_item_id`, so they reuse
 *     the existing `enqueue_meili_sync_inventory_item()` (COALESCE NEW/OLD
 *     inventory_item_id, op always 'UPDATE'). Catches: qty_ordered edits,
 *     receive (qty_received), receipt edit/void/delete, close/void
 *     (qty_cancelled), line insert/delete.
 *
 *  2. HEADER triggers on `purchase_order` + `factory_order`, firing only WHEN
 *     status changes. The header has no inventory_item_id, so a dedicated
 *     function enqueues EVERY child line's inventory_item_id. Catches the
 *     header-ONLY transition that line triggers miss: submit (draft→submitted)
 *     flips a line from not-counted to on-order without touching the line row.
 *     (close/void also write lines, so this is belt-and-suspenders for them.)
 *
 * op is always 'UPDATE' — deleting a PO/FO line must rebuild the item doc with
 * a lower on-order, never delete the inventory doc.
 */
export class AddOnOrderMeiliSyncTriggers1779400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. LINE triggers — reuse the existing per-item enqueue function ──
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_po_line ON purchase_order_line
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_po_line
      AFTER INSERT OR UPDATE OR DELETE ON purchase_order_line
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync_inventory_item()
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_fo_line ON factory_order_line
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_fo_line
      AFTER INSERT OR UPDATE OR DELETE ON factory_order_line
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync_inventory_item()
    `);

    // ── 2. HEADER triggers — enqueue all child line items on status change ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_sync_po_lines() RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        SELECT 'inventory_item', pol.inventory_item_id, 'UPDATE',
               current_setting('application_name', true)
        FROM purchase_order_line pol
        WHERE pol.purchase_order_id = NEW.id
          AND pol.inventory_item_id IS NOT NULL
          AND pol.deleted_at IS NULL;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_po_status ON purchase_order
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_po_status
      AFTER UPDATE OF status ON purchase_order
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION enqueue_meili_sync_po_lines()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_sync_fo_lines() RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        SELECT 'inventory_item', fol.inventory_item_id, 'UPDATE',
               current_setting('application_name', true)
        FROM factory_order_line fol
        WHERE fol.factory_order_id = NEW.id
          AND fol.inventory_item_id IS NOT NULL
          AND fol.deleted_at IS NULL;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_fo_status ON factory_order
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_fo_status
      AFTER UPDATE OF status ON factory_order
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION enqueue_meili_sync_fo_lines()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_po_line ON purchase_order_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_fo_line ON factory_order_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_po_status ON purchase_order`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_fo_status ON factory_order`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_sync_po_lines()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_sync_fo_lines()`
    );
    // enqueue_meili_sync_inventory_item() is owned by the inventory_level
    // migration — leave it intact.
  }
}
