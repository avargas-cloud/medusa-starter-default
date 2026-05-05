import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Assigns VB numbers to legacy vendor bills that were created as drafts before
 * draft-time numbering existed.
 */
export class Migration20260505120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      DO $$
      DECLARE
        bill_row RECORD;
      BEGIN
        FOR bill_row IN
          SELECT id
          FROM vendor_bill
          WHERE number IS NULL
            AND deleted_at IS NULL
          ORDER BY created_at ASC
        LOOP
          UPDATE vendor_bill
          SET number = 'VB-' || nextval('custom_vendor_bill_seq')::text,
              updated_at = NOW()
          WHERE id = bill_row.id;
        END LOOP;
      END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`SELECT 1;`);
  }
}
