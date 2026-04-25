import { Migration } from "@mikro-orm/migrations";

/**
 * Adds draft_number to purchase_order.
 * draft_number: permanent D-{n} label assigned at creation, never overwritten.
 * Backfills existing records: drafts still have their D-{n} in `number`;
 * submitted/received rows lost their draft ref — they get NULL (no backfill possible).
 */
export class Migration20260425180000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order"
         ADD COLUMN IF NOT EXISTS "draft_number" text NULL;`
    );
    // Backfill: drafts still carry "D-{n}" in their number column
    this.addSql(
      `UPDATE "purchase_order"
          SET "draft_number" = "number"
        WHERE "number" LIKE 'D-%'
          AND "draft_number" IS NULL;`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order"
         DROP COLUMN IF EXISTS "draft_number";`
    );
  }
}
