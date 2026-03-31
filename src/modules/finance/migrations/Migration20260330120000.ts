import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Migration20260330120000
 *
 * Creates the qb_legacy_so table — a lightweight reference table for
 * open Sales Orders that already exist in QuickBooks but predate Medusa.
 *
 * These records are used to:
 *   - Show staff which QB SOs don't yet have a Medusa order
 *   - Allow the "Save QB Info" modal to link existing QB data to future orders
 *   - Prevent duplicate SO creation for orders that were manually entered in QB
 */
export class Migration20260330120000 extends Migration {

    override async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS qb_legacy_so (
                id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                qb_txn_id           TEXT NOT NULL UNIQUE,
                qb_ref_number       TEXT,
                qb_customer_list_id TEXT,
                qb_customer_name    TEXT,
                txn_date            DATE,
                amount              NUMERIC(12, 2),
                balance_remaining   NUMERIC(12, 2),
                status              TEXT NOT NULL DEFAULT 'open',
                imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `)
        this.addSql(`CREATE INDEX IF NOT EXISTS idx_qb_legacy_so_ref ON qb_legacy_so (qb_ref_number);`)
        this.addSql(`CREATE INDEX IF NOT EXISTS idx_qb_legacy_so_customer ON qb_legacy_so (qb_customer_list_id);`)
    }

    override async down(): Promise<void> {
        this.addSql(`DROP TABLE IF EXISTS qb_legacy_so;`)
    }
}
