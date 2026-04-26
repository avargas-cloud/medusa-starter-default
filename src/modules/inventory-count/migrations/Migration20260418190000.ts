import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418190000
 *
 * Bootstraps the inventory-count module:
 *   - inventory_count                       (header, audit, denorm counters)
 *   - inventory_count_line                  (delta-based, FK to header CASCADE)
 *   - inventory_count_sequence              (atomic per-year numbering)
 *   - qb_inventory_adjustment_pipeline      (one row per count + qb_account)
 *
 * Status fields use `text` + CHECK constraints rather than Postgres ENUMs to
 * stay aligned with the existing Medusa-module convention (qb_item_pipeline).
 */
export class Migration20260418190000 extends Migration {
  override async up(): Promise<void> {
    // ── inventory_count ──────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "inventory_count" (
        "id"                          text not null,
        "number"                      text not null,
        "year"                        integer not null,
        "seq"                         integer not null,
        "status"                      text not null default 'draft'
          check ("status" in ('draft','submitted','approved','partially_applied','rejected','cancelled')),
        "stock_location_id"           text not null,
        "category_filter_id"          text null,
        "sku_prefix_filter"           text null,
        "memo"                        text null,
        "default_qb_account_list_id"  text not null default '8000007B-1369921375',
        "created_by_user_id"          text not null,
        "submitted_at"                timestamptz null,
        "reviewed_by_user_id"         text null,
        "reviewed_at"                 timestamptz null,
        "review_notes"                text null,
        "applied_at"                  timestamptz null,
        "qb_synced_at"                timestamptz null,
        "total_lines"                 integer not null default 0,
        "total_lines_applied"         integer not null default 0,
        "total_lines_blocked"         integer not null default 0,
        "total_delta_units"           integer not null default 0,
        "created_at"                  timestamptz not null default now(),
        "updated_at"                  timestamptz not null default now(),
        "deleted_at"                  timestamptz null,
        constraint "inventory_count_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_inventory_count_number" on "inventory_count" ("number") where deleted_at is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_inventory_count_year_seq" on "inventory_count" ("year","seq") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_status" on "inventory_count" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_stock_location_id" on "inventory_count" ("stock_location_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_created_by_user_id" on "inventory_count" ("created_by_user_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_reviewed_by_user_id" on "inventory_count" ("reviewed_by_user_id") where reviewed_by_user_id is not null and deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_submitted_at" on "inventory_count" ("submitted_at" desc) where submitted_at is not null and deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_inventory_count_deleted_at" on "inventory_count" ("deleted_at") where deleted_at is null;`
    );

    // ── inventory_count_line ─────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "inventory_count_line" (
        "id"                  text not null,
        "inventory_count_id"  text not null,
        "product_variant_id"  text not null,
        "inventory_item_id"   text not null,
        "sku"                 text not null,
        "product_title"       text not null,
        "qty_counted"         integer null,
        "qty_at_count_time"   integer null,
        "delta_original"      integer null,
        "delta_applied"       integer null,
        "qty_at_apply_time"   integer null,
        "projected_stock"     integer null,
        "status"              text not null default 'pending'
          check ("status" in ('pending','applied','blocked','skipped','overridden')),
        "block_reason"        text null
          check ("block_reason" is null or "block_reason" in ('projected_negative','sku_not_found','location_mismatch')),
        "override_note"       text null,
        "qb_account_list_id"  text null,
        "qb_line_index"       integer null,
        "qb_synced_at"        timestamptz null,
        "qb_last_error"       text null,
        "created_at"          timestamptz not null default now(),
        "updated_at"          timestamptz not null default now(),
        "deleted_at"          timestamptz null,
        constraint "inventory_count_line_pkey" primary key ("id"),
        constraint "FK_invcnl_inventory_count_id"
          foreign key ("inventory_count_id") references "inventory_count" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_invcnl_count_variant" on "inventory_count_line" ("inventory_count_id","product_variant_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_invcnl_inventory_count_id" on "inventory_count_line" ("inventory_count_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_invcnl_product_variant_id" on "inventory_count_line" ("product_variant_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_invcnl_status" on "inventory_count_line" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_invcnl_deleted_at" on "inventory_count_line" ("deleted_at") where deleted_at is null;`
    );

    // ── inventory_count_sequence ─────────────────────────────────────────────
    this.addSql(`
      create table if not exists "inventory_count_sequence" (
        "id"          text not null,
        "year"        integer not null,
        "last_seq"    integer not null default 0,
        "created_at"  timestamptz not null default now(),
        "updated_at"  timestamptz not null default now(),
        "deleted_at"  timestamptz null,
        constraint "inventory_count_sequence_pkey" primary key ("id"),
        constraint "UQ_inventory_count_sequence_year" unique ("year")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_inventory_count_sequence_deleted_at" on "inventory_count_sequence" ("deleted_at") where deleted_at is null;`
    );

    // ── qb_inventory_adjustment_pipeline ─────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_inventory_adjustment_pipeline" (
        "id"                   text not null,
        "inventory_count_id"   text not null,
        "qb_account_list_id"   text not null,
        "status"               text not null default 'waiting'
          check ("status" in ('waiting','processing','synced','error','cancelled')),
        "qb_operation_id"      text null,
        "qb_list_id"           text null,
        "qb_txn_number"        text null,
        "payload"              jsonb not null,
        "last_error"           text null,
        "retries"              integer not null default 0,
        "next_retry_at"        timestamptz null,
        "synced_at"            timestamptz null,
        "created_at"           timestamptz not null default now(),
        "updated_at"           timestamptz not null default now(),
        "deleted_at"           timestamptz null,
        constraint "qb_inventory_adjustment_pipeline_pkey" primary key ("id"),
        constraint "FK_qb_invadj_inventory_count_id"
          foreign key ("inventory_count_id") references "inventory_count" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_qb_invadj_count_account" on "qb_inventory_adjustment_pipeline" ("inventory_count_id","qb_account_list_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_invadj_status" on "qb_inventory_adjustment_pipeline" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_invadj_next_retry_at" on "qb_inventory_adjustment_pipeline" ("next_retry_at") where status in ('waiting','error') and deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_invadj_deleted_at" on "qb_inventory_adjustment_pipeline" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop table if exists "qb_inventory_adjustment_pipeline" cascade;`
    );
    this.addSql(`drop table if exists "inventory_count_sequence" cascade;`);
    this.addSql(`drop table if exists "inventory_count_line" cascade;`);
    this.addSql(`drop table if exists "inventory_count" cascade;`);
  }
}
