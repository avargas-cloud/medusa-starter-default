import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260529130000
 *
 * Add a `cost_snapshot` jsonb column to `payment_application`.
 *
 * Motivation: order-only payment applications (invoice_id IS NULL) feed
 * Treasury's COGS via the `order_lines` path, which today reads the LIVE
 * product average cost. That makes a closed day's COGS drift whenever a PO is
 * received later. We freeze the per-line cost basis at the moment the payment
 * is attributed to the order — mirroring what `pos_invoice_item.average_unit_cost`
 * already does for invoiced sales — so Treasury can read a stable value.
 *
 * Shape (written by buildOrderCostSnapshot):
 *   {
 *     captured_at: ISO string,
 *     lines: [{ line_id, variant_id, sku, quantity, unit_cost_cents, is_china }]
 *   }
 *
 * Additive, nullable, safe to backfill later. NULL = legacy row → Treasury
 * falls back to live metadata cost.
 */
export class Migration20260529130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE payment_application
      ADD COLUMN IF NOT EXISTS cost_snapshot jsonb NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE payment_application
      DROP COLUMN IF EXISTS cost_snapshot;
    `);
  }
}
