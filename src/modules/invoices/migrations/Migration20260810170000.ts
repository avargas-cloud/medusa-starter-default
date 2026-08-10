import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Durable line ordering for invoice items.
 *
 * pos_invoice_item rows are batch-inserted in the exact display order the POS
 * sends, but their ULID ids are NOT monotonic within the same millisecond
 * (Medusa's generateEntityId uses plain ulid(), random 80-bit entropy per
 * call) — and a whole batch routinely lands in one ms, so the read-side
 * "sort by id ASC" fix from 2026-07-02 shuffled lines whenever that happened.
 *
 * sort_order = 0-indexed array position at creation. NULL = legacy row;
 * readers fall back to id ASC (sortDocItemsByInsertion).
 *
 * Additive only — no data rewrite here. The 2026-08 backfill for affected
 * invoices lives in scripts/fix/backfill-invoice-item-sort-order.ts.
 */
export class Migration20260810170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      ADD COLUMN IF NOT EXISTS sort_order integer NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS sort_order;`
    );
  }
}
