import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260424140000
 *
 * Adds the Vendor Bill + Landing Cost tables:
 *   - vendor_bill       (header: per-receipt commission/freight/tariff settings)
 *   - vendor_bill_line  (per-SKU landed cost breakdown)
 *
 * One receipt → at most one vendor bill (UNIQUE on purchase_order_receipt_id).
 * Landed cost components are null until the bill is confirmed.
 *
 * Timestamps (created_at / updated_at / deleted_at) are managed by the
 * Medusa ORM layer and included here for raw-SQL compatibility.
 */
export class Migration20260424140000 extends Migration {
  override async up(): Promise<void> {
    // ── vendor_bill ───────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "vendor_bill" (
        "id"                              text not null,
        "purchase_order_receipt_id"       text not null,
        "purchase_order_id"               text not null,
        "status"                          text not null default 'draft'
          check ("status" in ('draft','confirmed','synced')),
        "commission_mode"                 text not null default 'percent'
          check ("commission_mode" in ('percent','fixed')),
        "commission_rate_bps"             integer not null default 0,
        "commission_amount_cents"         integer not null default 0,
        "commission_invoice_number"       text null,
        "freight_included"                boolean not null default false,
        "freight_amount_cents"            integer not null default 0,
        "freight_invoice_number"          text null,
        "tariff_included"                 boolean not null default false,
        "tariff_amount_cents"             integer not null default 0,
        "tariff_number"                   text null,
        "notes"                           text null,
        "confirmed_at"                    timestamptz null,
        "confirmed_by_user_id"            text null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "vendor_bill_pkey" primary key ("id"),
        constraint "FK_vb_receipt_id"
          foreign key ("purchase_order_receipt_id")
          references "purchase_order_receipt" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_vendor_bill_receipt_id" on "vendor_bill" ("purchase_order_receipt_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vb_purchase_order_id" on "vendor_bill" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vb_status" on "vendor_bill" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vb_deleted_at" on "vendor_bill" ("deleted_at") where "deleted_at" is null;`
    );

    // ── vendor_bill_line ──────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "vendor_bill_line" (
        "id"                              text not null,
        "vendor_bill_id"                  text not null,
        "receipt_line_id"                 text not null,
        "product_variant_id"              text not null,
        "sku"                             text not null,
        "description"                     text not null,
        "qty"                             integer not null,
        "unit_cost_cents"                 integer not null,
        "cbm_per_unit"                    float null,
        "commission_per_unit_cents"       integer not null default 0,
        "freight_per_unit_cents"          integer not null default 0,
        "tariff_per_unit_cents"           integer not null default 0,
        "landed_unit_cost_cents"          integer not null default 0,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "vendor_bill_line_pkey" primary key ("id"),
        constraint "FK_vbl_vendor_bill_id"
          foreign key ("vendor_bill_id")
          references "vendor_bill" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_vbl_vendor_bill_id" on "vendor_bill_line" ("vendor_bill_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vbl_receipt_line_id" on "vendor_bill_line" ("receipt_line_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vbl_product_variant_id" on "vendor_bill_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vbl_deleted_at" on "vendor_bill_line" ("deleted_at") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "vendor_bill_line" cascade;`);
    this.addSql(`drop table if exists "vendor_bill" cascade;`);
  }
}
