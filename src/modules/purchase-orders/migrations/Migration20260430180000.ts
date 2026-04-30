import { Migration } from "@mikro-orm/migrations";

/**
 * Adds a JSONB `metadata` column to `purchase_order` to persist receiving
 * worksheet snapshots (`receiving_drafts[]`) and any future ad-hoc PO metadata.
 */
export class Migration20260430180000 extends Migration {
  async up(): Promise<void> {
    await this.execute(
      `ALTER TABLE "purchase_order" ADD COLUMN IF NOT EXISTS "metadata" JSONB NULL`
    );
  }

  async down(): Promise<void> {
    await this.execute(
      `ALTER TABLE "purchase_order" DROP COLUMN IF EXISTS "metadata"`
    );
  }
}
