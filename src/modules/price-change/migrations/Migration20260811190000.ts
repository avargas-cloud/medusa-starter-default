import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260811190000
 *
 * Bootstraps the price-change module:
 *   - price_change_batch  (header, submit/approve/reject audit)
 *   - price_change_line   (one variant per line, FK to header CASCADE)
 *
 * Status uses `text` + CHECK constraint rather than a Postgres ENUM, matching
 * the existing module convention (inventory_count, qb_item_pipeline).
 */
export class Migration20260811190000 extends Migration {
  override async up(): Promise<void> {
    // ── price_change_batch ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "price_change_batch" (
        "id"                  text not null,
        "status"              text not null default 'submitted'
          check ("status" in ('submitted','approved','rejected')),
        "note"                text null,
        "created_by_user_id"  text not null,
        "created_by_email"    text not null,
        "submitted_at"        timestamptz not null,
        "reviewed_by_user_id" text null,
        "reviewed_by_email"   text null,
        "reviewed_at"         timestamptz null,
        "reject_reason"       text null,
        "line_count"          integer not null,
        "applied_summary"     jsonb null,
        "created_at"          timestamptz not null default now(),
        "updated_at"          timestamptz not null default now(),
        "deleted_at"          timestamptz null,
        constraint "price_change_batch_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_price_change_batch_status" on "price_change_batch" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_price_change_batch_submitted_at" on "price_change_batch" ("submitted_at" desc) where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_price_change_batch_created_by_user_id" on "price_change_batch" ("created_by_user_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_price_change_batch_deleted_at" on "price_change_batch" ("deleted_at") where deleted_at is null;`
    );

    // ── price_change_line ─────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "price_change_line" (
        "id"              text not null,
        "batch_id"        text not null,
        "variant_id"      text not null,
        "product_id"      text not null,
        "sku"             text null,
        "description"     text null,
        "old_cost"        numeric null,
        "raw_old_cost"    jsonb null,
        "new_cost"        numeric null,
        "raw_new_cost"    jsonb null,
        "old_retail"      numeric null,
        "raw_old_retail"  jsonb null,
        "new_retail"      numeric null,
        "raw_new_retail"  jsonb null,
        "old_wholesale"   numeric null,
        "raw_old_wholesale" jsonb null,
        "new_wholesale"   numeric null,
        "raw_new_wholesale" jsonb null,
        "created_at"      timestamptz not null default now(),
        "updated_at"      timestamptz not null default now(),
        "deleted_at"      timestamptz null,
        constraint "price_change_line_pkey" primary key ("id"),
        constraint "FK_pcl_batch_id"
          foreign key ("batch_id") references "price_change_batch" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_pcl_batch_id" on "price_change_line" ("batch_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pcl_variant_id" on "price_change_line" ("variant_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_pcl_deleted_at" on "price_change_line" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "price_change_line" cascade;`);
    this.addSql(`drop table if exists "price_change_batch" cascade;`);
  }
}
