import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260429000000
 *
 * 1. vendor_bill_cost_log  — AVCO audit ledger (one row per variant per confirm/cancel)
 * 2. vendor_bill.qb_txn_id / qb_edit_sequence — needed to void synced bills in QB Desktop
 */
export class Migration20260429000000 extends Migration {
  async up(): Promise<void> {
    // ── Cost log ──────────────────────────────────────────────────────────────
    await this.execute(`
      CREATE TABLE IF NOT EXISTS "vendor_bill_cost_log" (
        "id"                      TEXT        NOT NULL DEFAULT gen_random_uuid(),
        "vendor_bill_id"          TEXT        NOT NULL,
        "product_variant_id"      TEXT        NOT NULL,
        "received_qty"            INTEGER     NOT NULL,
        "landed_unit_cost_cents"  FLOAT       NOT NULL,
        "prev_qty_on_hand"        INTEGER     NOT NULL,
        "prev_avg_cost_cents"     FLOAT       NOT NULL,
        "new_avg_cost_cents"      FLOAT       NOT NULL,
        "applied_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "reversed_at"             TIMESTAMPTZ,
        "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "pk_vendor_bill_cost_log" PRIMARY KEY ("id")
      );
    `);
    await this.execute(
      `CREATE INDEX IF NOT EXISTS "idx_vbcl_vendor_bill_id"
         ON "vendor_bill_cost_log" ("vendor_bill_id");`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS "idx_vbcl_variant_id"
         ON "vendor_bill_cost_log" ("product_variant_id");`
    );

    // ── QB void support ───────────────────────────────────────────────────────
    await this.execute(
      `ALTER TABLE "vendor_bill"
         ADD COLUMN IF NOT EXISTS "qb_txn_id"        TEXT,
         ADD COLUMN IF NOT EXISTS "qb_edit_sequence"  TEXT;`
    );
  }

  async down(): Promise<void> {
    await this.execute(
      `ALTER TABLE "vendor_bill"
         DROP COLUMN IF EXISTS "qb_txn_id",
         DROP COLUMN IF EXISTS "qb_edit_sequence";`
    );
    await this.execute(`DROP TABLE IF EXISTS "vendor_bill_cost_log";`);
  }
}
