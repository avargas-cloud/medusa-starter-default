import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260420193000
 *
 * Bootstraps the unmet-demand module:
 *   - unmet_demand_record   (header + snapshotted totals for analytics)
 *   - unmet_demand_item     (requested | purchased lines, FK CASCADE)
 *
 * Status fields use `text` + CHECK constraints (not Postgres ENUMs) to
 * stay aligned with the existing custom-module convention.
 */
export class Migration20260420193000 extends Migration {
  override async up(): Promise<void> {
    // ── unmet_demand_record ──────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "unmet_demand_record" (
        "id"                      text not null,
        "customer_id"             text not null,
        "created_by_user_id"      text not null,
        "price_tier"              text not null default 'retail'
          check ("price_tier" in ('retail','wholesale')),
        "requested_total_cents"   integer not null default 0,
        "purchased_total_cents"   integer not null default 0,
        "unmet_value_cents"       integer not null default 0,
        "notes"                   text null,
        "created_at"              timestamptz not null default now(),
        "updated_at"              timestamptz not null default now(),
        "deleted_at"              timestamptz null,
        constraint "unmet_demand_record_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_umdrec_customer_id" on "unmet_demand_record" ("customer_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umdrec_created_by_user_id" on "unmet_demand_record" ("created_by_user_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umdrec_created_at" on "unmet_demand_record" ("created_at" desc) where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umdrec_unmet_value_cents" on "unmet_demand_record" ("unmet_value_cents") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umdrec_deleted_at" on "unmet_demand_record" ("deleted_at") where deleted_at is null;`
    );

    // ── unmet_demand_item ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "unmet_demand_item" (
        "id"                text not null,
        "record_id"         text not null,
        "kind"              text not null
          check ("kind" in ('requested','purchased')),
        "product_id"        text null,
        "variant_id"        text null,
        "sku"               text not null,
        "title"             text not null,
        "quantity"          integer not null default 1,
        "unit_price_cents"  integer not null default 0,
        "subtotal_cents"    integer not null default 0,
        "created_at"        timestamptz not null default now(),
        "updated_at"        timestamptz not null default now(),
        "deleted_at"        timestamptz null,
        constraint "unmet_demand_item_pkey" primary key ("id"),
        constraint "FK_umditm_record_id"
          foreign key ("record_id") references "unmet_demand_record" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_umditm_record_id_kind" on "unmet_demand_item" ("record_id","kind") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umditm_variant_id" on "unmet_demand_item" ("variant_id") where variant_id is not null and deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umditm_sku" on "unmet_demand_item" ("sku") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_umditm_deleted_at" on "unmet_demand_item" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "unmet_demand_item" cascade;`);
    this.addSql(`drop table if exists "unmet_demand_record" cascade;`);
  }
}
