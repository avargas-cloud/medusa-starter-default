import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Creates the landing_cost + landing_cost_line tables.
 * Standalone calculator — no FKs to purchase_order, receipt, or inventory.
 */
export class Migration20260428200000 extends Migration {
  override async up(): Promise<void> {
    // ── landing_cost ───────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "landing_cost" (
        "id"                              text not null,
        "reference_id"                    text null,
        "notes"                           text null,
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
        "recalculated_at"                 timestamptz null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "landing_cost_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_lc_deleted_at" on "landing_cost" ("deleted_at") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_lc_created_at" on "landing_cost" ("created_at") where "deleted_at" is null;`
    );

    // ── landing_cost_line ──────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "landing_cost_line" (
        "id"                              text not null,
        "landing_cost_id"                 text not null,
        "product_variant_id"              text null,
        "sku"                             text not null,
        "mpn"                             text null,
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
        constraint "landing_cost_line_pkey" primary key ("id"),
        constraint "FK_lcl_landing_cost_id"
          foreign key ("landing_cost_id")
          references "landing_cost" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_lcl_landing_cost_id" on "landing_cost_line" ("landing_cost_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_lcl_product_variant_id" on "landing_cost_line" ("product_variant_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_lcl_deleted_at" on "landing_cost_line" ("deleted_at") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "landing_cost_line" cascade;`);
    this.addSql(`drop table if exists "landing_cost" cascade;`);
  }
}
