import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Phase 0 — Vendor Bill (REGULAR) improvements.
 *
 * Adds a deterministic link from vendor_bill_line back to the
 * purchase_order_line it bills. Required so qty-cap validation,
 * "Update from PO", and line removal can match unambiguously even when a PO
 * repeats the same variant on multiple lines (variant matching alone is
 * ambiguous). See docs/VENDOR_BILL_REGULAR_IMPROVEMENTS_PLAN.md (constraint C1).
 *
 * Backfill is best-effort and idempotent:
 *   A) receipt-sourced lines  → mirror purchase_order_receipt_line.purchase_order_line_id
 *   B) open-PO (fill-from-po) lines → match by product_variant_id within the
 *      bill's PO, but ONLY when that variant maps to exactly one PO line
 *      (unambiguous). Ambiguous rows stay NULL and are resolved on next
 *      Update-from-PO / edit.
 */
export class Migration20260630120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "vendor_bill_line"
        add column if not exists "purchase_order_line_id" text null;
    `);

    this.addSql(`
      create index if not exists "IDX_vbl_purchase_order_line_id"
        on "vendor_bill_line" ("purchase_order_line_id")
        where "deleted_at" is null;
    `);

    // Backfill A — receipt-sourced lines mirror the receipt line's PO line.
    this.addSql(`
      update "vendor_bill_line" vbl
        set "purchase_order_line_id" = porl."purchase_order_line_id"
      from "purchase_order_receipt_line" porl
      where vbl."receipt_line_id" = porl."id"
        and vbl."receipt_line_id" is not null
        and vbl."purchase_order_line_id" is null
        and coalesce(vbl."line_type", 'product') = 'product';
    `);

    // Backfill B — open-PO lines: match by variant within the bill's PO,
    // only when the variant maps to exactly one PO line (HAVING count = 1).
    this.addSql(`
      update "vendor_bill_line" vbl
        set "purchase_order_line_id" = m."pol_id"
      from (
        select vb."id" as bill_id,
               pol."product_variant_id" as variant_id,
               min(pol."id") as pol_id
        from "vendor_bill" vb
        join "purchase_order_line" pol
          on pol."purchase_order_id" = vb."purchase_order_id"
         and pol."deleted_at" is null
        where vb."deleted_at" is null
          and vb."purchase_order_id" is not null
        group by vb."id", pol."product_variant_id"
        having count(*) = 1
      ) m
      where vbl."vendor_bill_id" = m."bill_id"
        and vbl."product_variant_id" = m."variant_id"
        and vbl."receipt_line_id" is null
        and vbl."purchase_order_line_id" is null
        and coalesce(vbl."line_type", 'product') = 'product';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_vbl_purchase_order_line_id";`);
    this.addSql(`
      alter table "vendor_bill_line"
        drop column if exists "purchase_order_line_id";
    `);
  }
}
