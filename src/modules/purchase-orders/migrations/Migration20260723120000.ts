import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260723120000
 *
 * Vendor Bill → QuickBooks sync, Phase 0 (foundations only — dormant, no
 * behavior change). See docs/VENDOR_BILL_QB_SYNC_PLAN.md §3 + §5.
 *
 * 1. vendor_bill        — new QB sync + payment-terms columns
 *    (qb_txn_id / qb_edit_sequence already exist from Migration20260429000000;
 *     included here with IF NOT EXISTS for idempotency, not re-created).
 * 2. vendor_bill_line    — new QB line + freight-charge columns
 * 3. qb_vendor_bill_pipeline — new pipeline table (one row per bill, mirrors
 *    qb_purchase_order_pipeline). Fully dormant: no poller/route reads or
 *    writes it yet.
 */
export class Migration20260723120000 extends Migration {
  async up(): Promise<void> {
    // ── vendor_bill ──────────────────────────────────────────────────────────
    await this.execute(`
      ALTER TABLE "vendor_bill"
        ADD COLUMN IF NOT EXISTS "qb_txn_id"           TEXT,
        ADD COLUMN IF NOT EXISTS "qb_edit_sequence"    TEXT,
        ADD COLUMN IF NOT EXISTS "qb_ref_number"       TEXT,
        ADD COLUMN IF NOT EXISTS "qb_synced_at"        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "qb_source"           TEXT,
        ADD COLUMN IF NOT EXISTS "payment_terms_days"  INTEGER,
        ADD COLUMN IF NOT EXISTS "due_date"            TIMESTAMPTZ;
    `);

    // ── vendor_bill_line ─────────────────────────────────────────────────────
    await this.execute(`
      ALTER TABLE "vendor_bill_line"
        ADD COLUMN IF NOT EXISTS "qb_txn_line_id"          TEXT,
        ADD COLUMN IF NOT EXISTS "line_kind"                TEXT,
        ADD COLUMN IF NOT EXISTS "freight_account_list_id"  TEXT,
        ADD COLUMN IF NOT EXISTS "amount_cents"              INTEGER;
    `);

    // ── qb_vendor_bill_pipeline ──────────────────────────────────────────────
    await this.execute(`
      CREATE TABLE IF NOT EXISTS "qb_vendor_bill_pipeline" (
        "id"                  TEXT        NOT NULL,
        "vendor_bill_id"      TEXT        NOT NULL,
        "purchase_order_id"   TEXT,
        "status"              TEXT        NOT NULL DEFAULT 'waiting',
        "intent"              TEXT        NOT NULL DEFAULT 'add',
        "qb_operation_id"     TEXT,
        "qb_txn_id"           TEXT,
        "qb_ref_number"       TEXT,
        "payload"             JSONB       NOT NULL DEFAULT '{}',
        "snapshot"            JSONB,
        "edit_sequence"       TEXT,
        "rebuild_generation"  INTEGER     NOT NULL DEFAULT 0,
        "retries"             INTEGER     NOT NULL DEFAULT 0,
        "next_retry_at"       TIMESTAMPTZ,
        "synced_at"           TIMESTAMPTZ,
        "last_error"          TEXT,
        "void_status"         TEXT,
        "void_operation_id"   TEXT,
        "void_last_error"     TEXT,
        "void_retries"        INTEGER     NOT NULL DEFAULT 0,
        "void_next_retry_at"  TIMESTAMPTZ,
        "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "deleted_at"          TIMESTAMPTZ,
        CONSTRAINT "pk_qb_vendor_bill_pipeline" PRIMARY KEY ("id")
      );
    `);

    // One-row-per-document convention (2026-07-15 rule): a bill can never
    // have two active pipeline rows.
    await this.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_qbvbpipe_vendor_bill_id"
        ON "qb_vendor_bill_pipeline" ("vendor_bill_id")
        WHERE "deleted_at" IS NULL;
    `);

    // Poller scan index.
    await this.execute(`
      CREATE INDEX IF NOT EXISTS "IDX_qbvbpipe_status_deleted_at"
        ON "qb_vendor_bill_pipeline" ("status", "deleted_at");
    `);
  }

  async down(): Promise<void> {
    await this.execute(`DROP TABLE IF EXISTS "qb_vendor_bill_pipeline";`);

    await this.execute(`
      ALTER TABLE "vendor_bill_line"
        DROP COLUMN IF EXISTS "qb_txn_line_id",
        DROP COLUMN IF EXISTS "line_kind",
        DROP COLUMN IF EXISTS "freight_account_list_id",
        DROP COLUMN IF EXISTS "amount_cents";
    `);

    await this.execute(`
      ALTER TABLE "vendor_bill"
        DROP COLUMN IF EXISTS "qb_ref_number",
        DROP COLUMN IF EXISTS "qb_synced_at",
        DROP COLUMN IF EXISTS "qb_source",
        DROP COLUMN IF EXISTS "payment_terms_days",
        DROP COLUMN IF EXISTS "due_date";
    `);
  }
}
