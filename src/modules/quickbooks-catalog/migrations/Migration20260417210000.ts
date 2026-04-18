import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260417210000 extends Migration {
  override async up(): Promise<void> {
    // ── qb_account ───────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_account" (
        "id"                text not null,
        "qb_list_id"        text not null,
        "full_name"         text not null,
        "name"              text not null,
        "account_type"      text not null,
        "parent_full_name"  text null,
        "currency"          text null,
        "is_active"         boolean not null default true,
        "last_synced_at"    timestamptz not null default now(),
        "metadata"          jsonb null,
        "created_at"        timestamptz not null default now(),
        "updated_at"        timestamptz not null default now(),
        "deleted_at"        timestamptz null,
        constraint "qb_account_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_qb_account_qb_list_id" on "qb_account" ("qb_list_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_account_account_type" on "qb_account" ("account_type") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_account_full_name" on "qb_account" ("full_name") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_account_deleted_at" on "qb_account" ("deleted_at") where deleted_at is null;`
    );

    // ── qb_vendor ────────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_vendor" (
        "id"              text not null,
        "qb_list_id"      text not null,
        "full_name"       text not null,
        "name"            text not null,
        "company_name"    text null,
        "account_number"  text null,
        "is_active"       boolean not null default true,
        "last_synced_at"  timestamptz not null default now(),
        "metadata"        jsonb null,
        "created_at"      timestamptz not null default now(),
        "updated_at"      timestamptz not null default now(),
        "deleted_at"      timestamptz null,
        constraint "qb_vendor_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_qb_vendor_qb_list_id" on "qb_vendor" ("qb_list_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_full_name" on "qb_vendor" ("full_name") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_deleted_at" on "qb_vendor" ("deleted_at") where deleted_at is null;`
    );

    // ── qb_item_pipeline ─────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_item_pipeline" (
        "id"                text not null,
        "variant_id"        text not null,
        "sku"               text not null,
        "qb_operation_id"   text null,
        "qb_list_id"        text null,
        "qb_edit_sequence"  text null,
        "item_type"         text not null default 'Inventory',
        "status"            text not null default 'waiting' check ("status" in ('waiting','synced','error')),
        "last_error"        text null,
        "retries"           integer not null default 0,
        "resolved_at"       timestamptz null,
        "created_at"        timestamptz not null default now(),
        "updated_at"        timestamptz not null default now(),
        "deleted_at"        timestamptz null,
        constraint "qb_item_pipeline_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_qb_item_pipeline_variant_id" on "qb_item_pipeline" ("variant_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_item_pipeline_status" on "qb_item_pipeline" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_item_pipeline_sku" on "qb_item_pipeline" ("sku") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_item_pipeline_deleted_at" on "qb_item_pipeline" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "qb_item_pipeline" cascade;`);
    this.addSql(`drop table if exists "qb_vendor" cascade;`);
    this.addSql(`drop table if exists "qb_account" cascade;`);
  }
}
