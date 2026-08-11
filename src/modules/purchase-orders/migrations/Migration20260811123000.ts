import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260811123000
 *
 * Split the PO's free-text into two fields with opposite audiences.
 *
 * `memo` claimed to serve both "internal notes" and "instructions for the
 * vendor", but it never printed and never left the POS — one field cannot be
 * both internal and vendor-facing at once. `memo` stays internal-only;
 * `vendor_notes` is the outbound half: it prints on the PO document (template
 * engine `notes` field key) and travels on the emailed PDF. Neither reaches
 * QuickBooks (the QB PO memo is a fixed "Medusa PO ####" string).
 *
 * Additive and nullable: no backfill, existing memos keep their (internal)
 * meaning unchanged.
 */
export class Migration20260811123000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "purchase_order"
        ADD COLUMN IF NOT EXISTS "vendor_notes" TEXT;
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE "purchase_order"
        DROP COLUMN IF EXISTS "vendor_notes";
    `);
  }
}
