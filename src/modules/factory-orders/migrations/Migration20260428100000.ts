import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260428100000
 *
 * Bootstraps the factory-orders module:
 *   - factory_order               (header, audit, denorm counters, totals)
 *   - factory_order_line          (SKU / cost / qty snapshots + received counter)
 *   - factory_order_receipt       (physical reception event — no QB sync)
 *   - factory_order_receipt_line  (per-line qty received in this shipment)
 *   - custom_factory_order_seq    → FO-{seq}
 *   - custom_fo_receipt_seq       → FRCP-{seq}
 *   - custom_fo_draft_seq         → FOD-{seq}
 *
 * No QB pipeline tables — this module is Medusa-only.
 */
export class Migration20260428100000 extends Migration {
  override async up(): Promise<void> {
    // ── sequences ─────────────────────────────────────────────────────────────
    this.addSql(
      `create sequence if not exists "custom_factory_order_seq" start 1000;`
    );
    this.addSql(
      `create sequence if not exists "custom_fo_receipt_seq" start 1000;`
    );
    this.addSql(
      `create sequence if not exists "custom_fo_draft_seq" start 1;`
    );

    // ── factory_order ─────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "factory_order" (
        "id"                          text not null,
        "number"                      text null,
        "seq"                         integer null,
        "status"                      text not null default 'draft'
          check ("status" in ('draft','submitted','partially_received','received','closed','cancelled','voided')),
        "po_status"                   text null,
        "vendor_id"                   text not null,
        "vendor_name_snapshot"        text null,
        "vendor_list_id_snapshot"     text null,
        "stock_location_id"           text not null,
        "ordered_at"                  timestamptz null,
        "expected_at"                 timestamptz null,
        "subtotal_cents"              integer not null default 0,
        "tax_cents"                   integer not null default 0,
        "shipping_cents"              integer not null default 0,
        "other_fees_cents"            integer not null default 0,
        "total_cents"                 integer not null default 0,
        "currency_code"               text not null default 'usd',
        "draft_number"                text null,
        "memo"                        text null,
        "reference_number"            text null,
        "linked_order_ids"            text null,
        "shipping_method"             text null,
        "payment_terms"               text null,
        "created_by_user_id"          text not null,
        "submitted_at"                timestamptz null,
        "submitted_by_user_id"        text null,
        "closed_at"                   timestamptz null,
        "closed_by_user_id"           text null,
        "close_reason"                text null,
        "cancelled_at"                timestamptz null,
        "cancelled_by_user_id"        text null,
        "cancel_reason"               text null,
        "voided_at"                   timestamptz null,
        "voided_by_user_id"           text null,
        "void_reason"                 text null,
        "total_lines"                 integer not null default 0,
        "total_units_ordered"         integer not null default 0,
        "total_units_received"        integer not null default 0,
        "created_at"                  timestamptz not null default now(),
        "updated_at"                  timestamptz not null default now(),
        "deleted_at"                  timestamptz null,
        constraint "factory_order_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_factory_order_number" on "factory_order" ("number") where "number" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_factory_order_seq" on "factory_order" ("seq") where "seq" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_status" on "factory_order" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_vendor_id" on "factory_order" ("vendor_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_created_by_user_id" on "factory_order" ("created_by_user_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_submitted_at" on "factory_order" ("submitted_at" desc) where "submitted_at" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_expected_at" on "factory_order" ("expected_at") where "expected_at" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_deleted_at" on "factory_order" ("deleted_at") where "deleted_at" is null;`
    );

    // ── factory_order_line ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "factory_order_line" (
        "id"                      text not null,
        "factory_order_id"        text not null,
        "product_variant_id"      text not null,
        "inventory_item_id"       text not null,
        "sku_snapshot"            text not null,
        "description_snapshot"    text not null,
        "qty_ordered"             integer not null,
        "qty_received"            integer not null default 0,
        "qty_cancelled"           integer not null default 0,
        "unit_cost_cents"         integer not null,
        "tax_cents"               integer not null default 0,
        "total_cents"             integer not null,
        "status"                  text not null default 'open'
          check ("status" in ('open','partial','complete','cancelled')),
        "line_order"              integer not null default 0,
        "notes"                   text null,
        "created_at"              timestamptz not null default now(),
        "updated_at"              timestamptz not null default now(),
        "deleted_at"              timestamptz null,
        constraint "factory_order_line_pkey" primary key ("id"),
        constraint "FK_fol_factory_order_id"
          foreign key ("factory_order_id") references "factory_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_fol_factory_order_id" on "factory_order_line" ("factory_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fol_product_variant_id" on "factory_order_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fol_inventory_item_id" on "factory_order_line" ("inventory_item_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fol_status" on "factory_order_line" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fol_deleted_at" on "factory_order_line" ("deleted_at") where "deleted_at" is null;`
    );

    // ── factory_order_receipt ─────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "factory_order_receipt" (
        "id"                      text not null,
        "factory_order_id"        text not null,
        "number"                  text not null,
        "seq"                     integer not null,
        "status"                  text not null default 'pending'
          check ("status" in ('pending','applied','voided','error')),
        "received_at"             timestamptz not null,
        "received_by_user_id"     text not null,
        "stock_location_id"       text not null,
        "notes"                   text null,
        "voided_at"               timestamptz null,
        "voided_by_user_id"       text null,
        "void_reason"             text null,
        "created_at"              timestamptz not null default now(),
        "updated_at"              timestamptz not null default now(),
        "deleted_at"              timestamptz null,
        constraint "factory_order_receipt_pkey" primary key ("id"),
        constraint "FK_fore_factory_order_id"
          foreign key ("factory_order_id") references "factory_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_factory_order_receipt_number" on "factory_order_receipt" ("number") where "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_factory_order_receipt_seq" on "factory_order_receipt" ("seq") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fore_factory_order_id" on "factory_order_receipt" ("factory_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fore_status" on "factory_order_receipt" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fore_received_at" on "factory_order_receipt" ("received_at" desc) where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fore_received_by_user_id" on "factory_order_receipt" ("received_by_user_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_fore_deleted_at" on "factory_order_receipt" ("deleted_at") where "deleted_at" is null;`
    );

    // ── factory_order_receipt_line ────────────────────────────────────────────
    this.addSql(`
      create table if not exists "factory_order_receipt_line" (
        "id"                          text not null,
        "factory_order_receipt_id"    text not null,
        "factory_order_line_id"       text not null,
        "factory_order_id"            text not null,
        "product_variant_id"          text not null,
        "inventory_item_id"           text not null,
        "sku_snapshot"                text not null,
        "description_snapshot"        text not null,
        "qty_received_now"            integer not null,
        "unit_cost_cents_override"    integer null,
        "stock_applied"               boolean not null default false,
        "stock_applied_at"            timestamptz null,
        "lot_number"                  text null,
        "serial_numbers"              jsonb null,
        "created_at"                  timestamptz not null default now(),
        "updated_at"                  timestamptz not null default now(),
        "deleted_at"                  timestamptz null,
        constraint "factory_order_receipt_line_pkey" primary key ("id"),
        constraint "FK_forl_receipt_id"
          foreign key ("factory_order_receipt_id") references "factory_order_receipt" ("id") on delete cascade,
        constraint "FK_forl_fo_line_id"
          foreign key ("factory_order_line_id") references "factory_order_line" ("id") on delete cascade,
        constraint "FK_forl_factory_order_id"
          foreign key ("factory_order_id") references "factory_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_forl_receipt_id" on "factory_order_receipt_line" ("factory_order_receipt_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_forl_fo_line_id" on "factory_order_receipt_line" ("factory_order_line_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_forl_factory_order_id" on "factory_order_receipt_line" ("factory_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_forl_product_variant_id" on "factory_order_receipt_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_forl_stock_applied" on "factory_order_receipt_line" ("stock_applied") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_forl_deleted_at" on "factory_order_receipt_line" ("deleted_at") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop table if exists "factory_order_receipt_line" cascade;`
    );
    this.addSql(`drop table if exists "factory_order_receipt" cascade;`);
    this.addSql(`drop table if exists "factory_order_line" cascade;`);
    this.addSql(`drop table if exists "factory_order" cascade;`);
    this.addSql(`drop sequence if exists "custom_fo_draft_seq";`);
    this.addSql(`drop sequence if exists "custom_fo_receipt_seq";`);
    this.addSql(`drop sequence if exists "custom_factory_order_seq";`);
  }
}
