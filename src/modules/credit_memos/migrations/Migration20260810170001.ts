import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Durable line ordering for credit-memo items — same defect class as
 * pos_invoice_item (see invoices/Migration20260810170000): batch-inserted
 * rows share a millisecond, ULIDs are not monotonic within one ms, so
 * "sort by id ASC" cannot restore the display order the POS sent.
 *
 * sort_order = 0-indexed array position at creation. NULL = legacy row;
 * readers fall back to id ASC.
 */
export class Migration20260810170001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_credit_memo_item
      ADD COLUMN IF NOT EXISTS sort_order integer NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE pos_credit_memo_item DROP COLUMN IF EXISTS sort_order;`
    );
  }
}
