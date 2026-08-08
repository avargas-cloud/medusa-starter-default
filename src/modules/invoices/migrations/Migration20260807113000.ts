import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Delivery v2 phase 1 — line identity + link mode.
 *
 * - pos_invoice_item.order_line_item_id: which order line (`ordli_`) this
 *   invoice line bills. Nullable: legacy invoices and custom/comment lines
 *   stay NULL forever. Indexed for the per-order invoiced-quantity rollup.
 * - pos_invoice.shipment_link_mode: 'legacy_1to1' (default — every existing
 *   row) vs 'derived_v2' (all merchandise lines carry their line id; dispatch
 *   links live in order_delivery and void never reverses dispatched stock).
 *
 * Additive only — no data rewrite, no behavior change until readers opt in.
 */
export class Migration20260807113000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      ADD COLUMN IF NOT EXISTS order_line_item_id text NULL;
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_pos_invoice_item_order_line_item
      ON pos_invoice_item (order_line_item_id)
      WHERE order_line_item_id IS NOT NULL;
    `);
    this.addSql(`
      ALTER TABLE pos_invoice
      ADD COLUMN IF NOT EXISTS shipment_link_mode text NOT NULL DEFAULT 'legacy_1to1';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_pos_invoice_item_order_line_item;`);
    this.addSql(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS order_line_item_id;`
    );
    this.addSql(
      `ALTER TABLE pos_invoice DROP COLUMN IF EXISTS shipment_link_mode;`
    );
  }
}
