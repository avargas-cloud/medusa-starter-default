import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260723130000
 *
 * Vendor Bill → QuickBooks sync, Phase 1 (D6 — bill ↔ MANY receipts).
 * See docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.0.
 *
 * Today `vendor_bill.purchase_order_receipt_id` is a single nullable column
 * (one bill per receipt, Option A). D6 requires a bill to span MULTIPLE
 * receipts while a receipt still belongs to AT MOST one bill. Chosen shape
 * (the plan's "preferred" option): a FK on the RECEIPT side —
 * `purchase_order_receipt.vendor_bill_id`.
 *
 * This is a DUAL-READ/DUAL-WRITE transition, not a big-bang swap:
 *   - `purchase_order_receipt.vendor_bill_id` becomes the new source of truth
 *     for "which bill is this receipt bound to" (a receipt has ≤1 bill; no
 *     partial-unique index is needed for that constraint — a nullable FK
 *     already enforces "at most one bill per receipt").
 *   - `vendor_bill.purchase_order_receipt_id` (existing, UNIQUE) is KEPT and
 *     mirrors the FIRST bound receipt (by receipt seq) for legacy readers —
 *     see lib/purchase-orders/vendor-bill-receipts.ts::syncPrimaryReceiptPointer.
 *   - The old UNIQUE column is NOT dropped in this migration (readers are
 *     migrated incrementally per the plan's blast-radius sweep).
 *
 * Backfill: for every existing vendor_bill.purchase_order_receipt_id, stamp
 * the matching receipt's new vendor_bill_id so the two columns start in sync.
 * Idempotent (IF NOT EXISTS + backfill only fills currently-NULL rows).
 */
export class Migration20260723130000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "purchase_order_receipt"
        ADD COLUMN IF NOT EXISTS "vendor_bill_id" TEXT NULL;
    `);

    // Lookup index for "which receipts are bound to this bill" (GET receipts[]/
    // bindable_receipts[], confirm-route SET resolution) and for the
    // "is this receipt already billed" existence checks in the binding routes.
    await this.execute(`
      CREATE INDEX IF NOT EXISTS "IDX_por_vendor_bill_id"
        ON "purchase_order_receipt" ("vendor_bill_id")
        WHERE "deleted_at" IS NULL;
    `);

    // Backfill from the legacy single-receipt pin — only touches receipts that
    // don't already carry a vendor_bill_id (safe to re-run).
    await this.execute(`
      UPDATE "purchase_order_receipt" por
         SET "vendor_bill_id" = vb.id
        FROM "vendor_bill" vb
       WHERE vb."purchase_order_receipt_id" = por.id
         AND vb."deleted_at" IS NULL
         AND por."vendor_bill_id" IS NULL;
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      DROP INDEX IF EXISTS "IDX_por_vendor_bill_id";
    `);
    await this.execute(`
      ALTER TABLE "purchase_order_receipt"
        DROP COLUMN IF EXISTS "vendor_bill_id";
    `);
  }
}
