import { Migration } from "@mikro-orm/migrations";

/**
 * Tracks how many units of each IT line have been confirmed received via PO.
 *
 * shipped_in_transit = qty - qty_received  (while IT.status = 'shipped')
 * China available    = stocked_quantity - SUM(shipped_in_transit across all active ITs)
 */
export class Migration20260429200000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE inventory_transfer_line
         ADD COLUMN IF NOT EXISTS qty_received INTEGER NOT NULL DEFAULT 0;`
    );
    this.addSql(
      `ALTER TABLE inventory_transfer_line
         ADD CONSTRAINT chk_itl_qty_received CHECK (qty_received >= 0 AND qty_received <= qty);`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE inventory_transfer_line
         DROP CONSTRAINT IF EXISTS chk_itl_qty_received;`
    );
    this.addSql(
      `ALTER TABLE inventory_transfer_line DROP COLUMN IF EXISTS qty_received;`
    );
  }
}
