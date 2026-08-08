import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Delivery v2 phase 1 — pool + explicit invoice assignment.
 *
 * - order_delivery gains the assignment triple (invoice_scope / assigned_at /
 *   assigned_by_user_id). A row with invoice_id NULL is a label sitting in the
 *   order's pool; assignment stamps invoice_id + these fields.
 * - order_delivery_line: units covered by an item-scoped assignment
 *   (invoice_scope='items'), mirroring purchase_order_tracking_line.
 *
 * Additive only. The scope CHECK follows the module convention of living in
 * SQL (see order_delivery_provider_check in Migration20260709120000).
 */
export class Migration20260807114000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE order_delivery
      ADD COLUMN IF NOT EXISTS invoice_scope text NULL,
      ADD COLUMN IF NOT EXISTS assigned_at timestamptz NULL,
      ADD COLUMN IF NOT EXISTS assigned_by_user_id text NULL;
    `);
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'order_delivery_invoice_scope_check'
        ) THEN
          ALTER TABLE order_delivery
          ADD CONSTRAINT order_delivery_invoice_scope_check
          CHECK (invoice_scope IS NULL OR invoice_scope IN ('entire_invoice', 'items'));
        END IF;
      END $$;
    `);
    this.addSql(`
      CREATE TABLE IF NOT EXISTS order_delivery_line (
        id text NOT NULL PRIMARY KEY,
        delivery_id text NOT NULL,
        order_line_item_id text NOT NULL,
        quantity integer NOT NULL CHECK (quantity > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      );
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_order_delivery_line_delivery
      ON order_delivery_line (delivery_id)
      WHERE deleted_at IS NULL;
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_order_delivery_line_order_line
      ON order_delivery_line (order_line_item_id)
      WHERE deleted_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS order_delivery_line;`);
    this.addSql(`
      ALTER TABLE order_delivery
      DROP CONSTRAINT IF EXISTS order_delivery_invoice_scope_check;
    `);
    this.addSql(`
      ALTER TABLE order_delivery
      DROP COLUMN IF EXISTS invoice_scope,
      DROP COLUMN IF EXISTS assigned_at,
      DROP COLUMN IF EXISTS assigned_by_user_id;
    `);
  }
}
