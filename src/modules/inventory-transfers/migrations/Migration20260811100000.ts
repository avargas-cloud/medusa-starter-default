import { Migration } from "@mikro-orm/migrations";

/**
 * Adds per-line identity to the PO↔IT mirror.
 *
 * IT lines were matched to PO lines by product_variant_id, which is NOT unique
 * within a PO (the Sample-Product placeholder variant appears on multiple
 * lines). Two PO lines sharing a variant collapsed into ONE IT line — the
 * upsert overwrote instead of inserting (PO-1138/IT-1045, PO-1087/IT-1036).
 *
 * The backfill only links rows where the (transfer, variant) → PO line match
 * is unambiguous (exactly one candidate PO line). Ambiguous rows — the two
 * collapsed ITs — stay NULL and are repaired by an explicit data-fix script.
 */
export class Migration20260811100000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE inventory_transfer_line
         ADD COLUMN IF NOT EXISTS purchase_order_line_id TEXT NULL;`
    );
    this.addSql(
      `UPDATE inventory_transfer_line itl
          SET purchase_order_line_id = m.pol_id
         FROM (
           SELECT itl2.id AS itl_id, MIN(pol.id) AS pol_id
             FROM inventory_transfer_line itl2
             JOIN inventory_transfer it ON it.id = itl2.transfer_id
             JOIN purchase_order_line pol
               ON pol.purchase_order_id = it.linked_purchase_order_id
              AND pol.product_variant_id = itl2.product_variant_id
              AND pol.deleted_at IS NULL
            WHERE itl2.deleted_at IS NULL
              AND itl2.purchase_order_line_id IS NULL
            GROUP BY itl2.id
           HAVING COUNT(pol.id) = 1
         ) m
        WHERE itl.id = m.itl_id;`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE inventory_transfer_line
         DROP COLUMN IF EXISTS purchase_order_line_id;`
    );
  }
}
