import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Chunk 1 of ItemReceipt MOD pipeline.
 *
 * 1. purchase_order_receipt gains qb_edit_sequence (TEXT NULL).
 *    Required to build ItemReceiptModRq — QB Desktop rejects Mods that
 *    don't echo back the latest EditSequence (optimistic concurrency).
 *
 * 2. qb_item_receipt_pipeline gains a MOD lifecycle that runs in parallel
 *    to the existing ADD (status/retries/...) and VOID (void_status/...)
 *    lifecycles. One pipeline row per receipt — three independent channels.
 *
 *    mod_status transitions:
 *      NULL → waiting → submitted → completed
 *                              ↘ failed_permanent (retries exhausted)
 *
 * Backwards-compatible: all columns NULL by default. Nothing reads them
 * until the poller and PATCH route are updated in chunks 3 and 4.
 */
export class Migration20260514183500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
      ADD COLUMN IF NOT EXISTS "qb_edit_sequence" TEXT NULL;
    `);

    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      ADD COLUMN IF NOT EXISTS "mod_status" TEXT NULL,
      ADD COLUMN IF NOT EXISTS "mod_operation_id" TEXT NULL,
      ADD COLUMN IF NOT EXISTS "mod_retries" INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "mod_last_error" TEXT NULL,
      ADD COLUMN IF NOT EXISTS "mod_payload" JSONB NULL,
      ADD COLUMN IF NOT EXISTS "mod_next_retry_at" TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS "mod_synced_at" TIMESTAMPTZ NULL;
    `);

    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      DROP CONSTRAINT IF EXISTS "qb_item_receipt_pipeline_mod_status_check";
    `);
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      ADD CONSTRAINT "qb_item_receipt_pipeline_mod_status_check"
      CHECK ("mod_status" IS NULL OR "mod_status" IN (
        'waiting',
        'submitted',
        'completed',
        'error',
        'failed_permanent'
      ));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      DROP CONSTRAINT IF EXISTS "qb_item_receipt_pipeline_mod_status_check";
    `);
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      DROP COLUMN IF EXISTS "mod_status",
      DROP COLUMN IF EXISTS "mod_operation_id",
      DROP COLUMN IF EXISTS "mod_retries",
      DROP COLUMN IF EXISTS "mod_last_error",
      DROP COLUMN IF EXISTS "mod_payload",
      DROP COLUMN IF EXISTS "mod_next_retry_at",
      DROP COLUMN IF EXISTS "mod_synced_at";
    `);
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
      DROP COLUMN IF EXISTS "qb_edit_sequence";
    `);
  }
}
