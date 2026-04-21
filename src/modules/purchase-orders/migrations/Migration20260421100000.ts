import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260421100000
 *
 * Bootstraps the purchase-orders module:
 *   - purchase_order               (header, audit, denorm counters, totals)
 *   - purchase_order_line          (SKU / cost / qty snapshots + received counter)
 *   - purchase_order_receipt       (physical reception event, ItemReceipt hook)
 *   - purchase_order_receipt_line  (per-line qty received in this shipment)
 *   - custom_purchase_order_seq    (shared Postgres sequence, PO-{seq})
 *   - custom_po_receipt_seq        (shared Postgres sequence, RCP-{seq})
 *
 * Status fields use `text` + CHECK constraints (no Postgres ENUMs) to stay
 * aligned with the inventory-count / invoices module convention.
 *
 * QB pipeline tables live in a separate migration (20260421110000) so the
 * schema can be reverted independently from the QB integration.
 */
export class Migration20260421100000 extends Migration {
  override async up(): Promise<void> {
    // ── sequences ────────────────────────────────────────────────────────────
    this.addSql(
      `create sequence if not exists "custom_purchase_order_seq" start 1000;`
    );
    this.addSql(
      `create sequence if not exists "custom_po_receipt_seq" start 1000;`
    );

    // ── purchase_order ───────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order" (
        "id"                              text not null,
        "number"                          text null,
        "seq"                             integer null,
        "status"                          text not null default 'draft'
          check ("status" in ('draft','submitted','partially_received','received','closed','cancelled','voided')),
        "vendor_id"                       text not null,
        "vendor_name_snapshot"            text null,
        "vendor_qb_list_id_snapshot"      text null,
        "stock_location_id"               text not null,
        "ordered_at"                      timestamptz null,
        "expected_at"                     timestamptz null,
        "subtotal_cents"                  integer not null default 0,
        "tax_cents"                       integer not null default 0,
        "shipping_cents"                  integer not null default 0,
        "other_fees_cents"                integer not null default 0,
        "total_cents"                     integer not null default 0,
        "currency_code"                   text not null default 'usd',
        "memo"                            text null,
        "reference_number"                text null,
        "created_by_user_id"              text not null,
        "submitted_at"                    timestamptz null,
        "submitted_by_user_id"            text null,
        "closed_at"                       timestamptz null,
        "closed_by_user_id"               text null,
        "close_reason"                    text null,
        "cancelled_at"                    timestamptz null,
        "cancelled_by_user_id"            text null,
        "cancel_reason"                   text null,
        "voided_at"                       timestamptz null,
        "voided_by_user_id"               text null,
        "void_reason"                     text null,
        "total_lines"                     integer not null default 0,
        "total_units_ordered"             integer not null default 0,
        "total_units_received"            integer not null default 0,
        "qb_purchase_order_list_id"       text null,
        "qb_purchase_order_txn_number"    text null,
        "qb_synced_at"                    timestamptz null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "purchase_order_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_purchase_order_number" on "purchase_order" ("number") where "number" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_purchase_order_seq" on "purchase_order" ("seq") where "seq" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_status" on "purchase_order" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_vendor_id" on "purchase_order" ("vendor_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_stock_location_id" on "purchase_order" ("stock_location_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_created_by_user_id" on "purchase_order" ("created_by_user_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_submitted_at" on "purchase_order" ("submitted_at" desc) where "submitted_at" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_expected_at" on "purchase_order" ("expected_at") where "expected_at" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_deleted_at" on "purchase_order" ("deleted_at") where "deleted_at" is null;`
    );

    // ── purchase_order_line ──────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_line" (
        "id"                          text not null,
        "purchase_order_id"           text not null,
        "product_variant_id"          text not null,
        "inventory_item_id"           text not null,
        "sku_snapshot"                text not null,
        "description_snapshot"        text not null,
        "qb_item_list_id_snapshot"    text null,
        "qty_ordered"                 integer not null,
        "qty_received"                integer not null default 0,
        "qty_cancelled"               integer not null default 0,
        "unit_cost_cents"             integer not null,
        "tax_cents"                   integer not null default 0,
        "total_cents"                 integer not null,
        "status"                      text not null default 'open'
          check ("status" in ('open','partial','complete','cancelled')),
        "line_order"                  integer not null default 0,
        "notes"                       text null,
        "created_at"                  timestamptz not null default now(),
        "updated_at"                  timestamptz not null default now(),
        "deleted_at"                  timestamptz null,
        constraint "purchase_order_line_pkey" primary key ("id"),
        constraint "FK_pol_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_pol_purchase_order_id" on "purchase_order_line" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pol_product_variant_id" on "purchase_order_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pol_inventory_item_id" on "purchase_order_line" ("inventory_item_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pol_status" on "purchase_order_line" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pol_deleted_at" on "purchase_order_line" ("deleted_at") where "deleted_at" is null;`
    );

    // ── purchase_order_receipt ───────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_receipt" (
        "id"                              text not null,
        "purchase_order_id"               text not null,
        "number"                          text not null,
        "seq"                             integer not null,
        "status"                          text not null default 'pending'
          check ("status" in ('pending','applied','synced','voided','error')),
        "received_at"                     timestamptz not null,
        "received_by_user_id"             text not null,
        "stock_location_id"               text not null,
        "vendor_bill_number"              text null,
        "vendor_bill_date"                timestamptz null,
        "notes"                           text null,
        "qb_item_receipt_list_id"         text null,
        "qb_item_receipt_txn_number"      text null,
        "qb_synced_at"                    timestamptz null,
        "voided_at"                       timestamptz null,
        "voided_by_user_id"               text null,
        "void_reason"                     text null,
        "qb_void_list_id"                 text null,
        "qb_void_synced_at"               timestamptz null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "purchase_order_receipt_pkey" primary key ("id"),
        constraint "FK_por_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_purchase_order_receipt_number" on "purchase_order_receipt" ("number") where "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_purchase_order_receipt_seq" on "purchase_order_receipt" ("seq") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_purchase_order_id" on "purchase_order_receipt" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_status" on "purchase_order_receipt" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_received_at" on "purchase_order_receipt" ("received_at" desc) where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_received_by_user_id" on "purchase_order_receipt" ("received_by_user_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_stock_location_id" on "purchase_order_receipt" ("stock_location_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_por_deleted_at" on "purchase_order_receipt" ("deleted_at") where "deleted_at" is null;`
    );

    // ── purchase_order_receipt_line ──────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_receipt_line" (
        "id"                              text not null,
        "purchase_order_receipt_id"       text not null,
        "purchase_order_line_id"          text not null,
        "purchase_order_id"               text not null,
        "product_variant_id"              text not null,
        "inventory_item_id"               text not null,
        "sku_snapshot"                    text not null,
        "description_snapshot"            text not null,
        "qb_item_list_id_snapshot"        text null,
        "qty_received_now"                integer not null,
        "unit_cost_cents_override"        integer null,
        "stock_applied"                   boolean not null default false,
        "stock_applied_at"                timestamptz null,
        "lot_number"                      text null,
        "serial_numbers"                  jsonb null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "purchase_order_receipt_line_pkey" primary key ("id"),
        constraint "FK_porl_receipt_id"
          foreign key ("purchase_order_receipt_id") references "purchase_order_receipt" ("id") on delete cascade,
        constraint "FK_porl_po_line_id"
          foreign key ("purchase_order_line_id") references "purchase_order_line" ("id") on delete cascade,
        constraint "FK_porl_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_porl_receipt_id" on "purchase_order_receipt_line" ("purchase_order_receipt_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_porl_po_line_id" on "purchase_order_receipt_line" ("purchase_order_line_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_porl_purchase_order_id" on "purchase_order_receipt_line" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_porl_product_variant_id" on "purchase_order_receipt_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_porl_stock_applied" on "purchase_order_receipt_line" ("stock_applied") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_porl_deleted_at" on "purchase_order_receipt_line" ("deleted_at") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "purchase_order_receipt_line" cascade;`);
    this.addSql(`drop table if exists "purchase_order_receipt" cascade;`);
    this.addSql(`drop table if exists "purchase_order_line" cascade;`);
    this.addSql(`drop table if exists "purchase_order" cascade;`);
    this.addSql(`drop sequence if exists "custom_po_receipt_seq";`);
    this.addSql(`drop sequence if exists "custom_purchase_order_seq";`);
  }
}
