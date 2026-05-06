import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Allows item receipt pipeline rows to land in failed_permanent after retries
 * are exhausted, matching the poller and the purchase order pipeline.
 */
export class Migration20260506134308 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      DROP CONSTRAINT IF EXISTS "qb_item_receipt_pipeline_status_check";
    `);
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      ADD CONSTRAINT "qb_item_receipt_pipeline_status_check"
      CHECK ("status" IN (
        'waiting',
        'processing',
        'synced',
        'error',
        'cancelled',
        'failed_permanent'
      ));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      DROP CONSTRAINT IF EXISTS "qb_item_receipt_pipeline_status_check";
    `);
    this.addSql(`
      ALTER TABLE "qb_item_receipt_pipeline"
      ADD CONSTRAINT "qb_item_receipt_pipeline_status_check"
      CHECK ("status" IN (
        'waiting',
        'processing',
        'synced',
        'error',
        'cancelled'
      ));
    `);
  }
}
