import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Inventory Timeline scaling — index factory_order_receipt_line by inventory_item_id.
 *
 * Why: the aging report (GET /admin/reports/inventory-timeline) now joins the
 * receipt-line history to an "active items" set (China stock <> 0 OR in transit)
 * on `inventory_item_id` so fully-received/departed products drop out of the
 * scan. factory_order_receipt_line had indexes on receipt_id / factory_order_id /
 * product_variant_id but NOT on inventory_item_id, so that join fell back to a
 * seq-scan of all receipt history. As receipt history grows unbounded this is the
 * scan we must keep bounded.
 *
 * Purely additive: a partial btree index matching the report's `deleted_at IS NULL`
 * filter. `IF NOT EXISTS` keeps it idempotent.
 */
export class AddInventoryItemIndexToForl1779800000000
  implements MigrationInterface
{
  name = "AddInventoryItemIndexToForl1779800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_forl_inventory_item_id"
         ON factory_order_receipt_line (inventory_item_id)
       WHERE deleted_at IS NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_forl_inventory_item_id"`
    );
  }
}
