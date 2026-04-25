import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260424000000
 *
 * Bootstraps the purchasing module:
 *   - product_alternative        (primary ↔ alt variant equivalence links)
 *   - purchasing_config          (algorithm parameters, key/value)
 *   - purchasing_snapshot        (cached engine output per variant, rebuilt nightly)
 *   - purchasing_sales_history   (monthly sales per variant; excel_import + medusa_orders)
 *
 * Sequences: none — IDs use gen_random_uuid() via model.id().
 * QB Bridge: none — this module is fully independent of the QB pipeline.
 */
export class Migration20260424000000 extends Migration {
  override async up(): Promise<void> {
    // ── product_alternative ────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "product_alternative" (
        "id"                   text not null,
        "primary_variant_id"   text not null,
        "alt_variant_id"       text not null,
        "priority"             integer not null default 1,
        "is_active"            boolean not null default true,
        "created_at"           timestamptz not null default now(),
        "updated_at"           timestamptz not null default now(),
        "deleted_at"           timestamptz null,
        constraint "product_alternative_pkey" primary key ("id"),
        constraint "product_alternative_pair_uq" unique ("primary_variant_id", "alt_variant_id")
      );
    `);
    this.addSql(`create index if not exists "idx_palt_primary" on "product_alternative" ("primary_variant_id") where "deleted_at" is null;`);
    this.addSql(`create index if not exists "idx_palt_alt"     on "product_alternative" ("alt_variant_id")     where "deleted_at" is null;`);

    // ── purchasing_config ──────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchasing_config" (
        "key"    text not null,
        "value"  text not null,
        "label"  text null,
        constraint "purchasing_config_pkey" primary key ("key")
      );
    `);
    this.addSql(`
      insert into "purchasing_config" ("key", "value", "label") values
        ('weight_tier0_30d',          '0.30',  'Weight: last 30 days'),
        ('weight_q4',                 '0.25',  'Weight: Q4 months 10-12'),
        ('weight_q3',                 '0.20',  'Weight: Q3 months 7-9'),
        ('weight_q2',                 '0.15',  'Weight: Q2 months 4-6'),
        ('weight_q1',                 '0.10',  'Weight: Q1 months 1-3 (oldest)'),
        ('tendency_adj',              '0.05',  'Tendency adjustment (+5% = 0.05)'),
        ('business_days_per_month',   '26',    'Business days per month'),
        ('pareto_a_threshold',        '0.80',  'ABC class A threshold (cumulative revenue %)'),
        ('pareto_b_threshold',        '0.95',  'ABC class B threshold (cumulative revenue %)'),
        ('xyz_x_threshold',           '0.50',  'XYZ class X: CV max (stable demand)'),
        ('xyz_y_threshold',           '1.00',  'XYZ class Y: CV max (variable demand)'),
        ('transit_air_days',          '12',    'Air transit days (China → USA)'),
        ('buffer_air_days',           '15',    'Air safety buffer days'),
        ('transit_sea_days',          '90',    'Sea transit days (China → USA)'),
        ('buffer_sea_days',           '45',    'Sea safety buffer days')
      on conflict ("key") do nothing;
    `);

    // ── purchasing_snapshot ────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchasing_snapshot" (
        "id"                   text not null,
        "variant_id"           text not null,
        "tier0_30d"            numeric(14,4) not null default 0,
        "sales_q4"             numeric(14,4) not null default 0,
        "sales_q3"             numeric(14,4) not null default 0,
        "sales_q2"             numeric(14,4) not null default 0,
        "sales_q1"             numeric(14,4) not null default 0,
        "daily_sales_est"      numeric(14,4) not null default 0,
        "monthly_sales_est"    numeric(14,4) not null default 0,
        "cv"                   numeric(10,4) not null default 0,
        "weighted_revenue"     numeric(14,2) not null default 0,
        "pareto_rank"          integer null,
        "abc_class"            text null check ("abc_class" in ('A','B','C')),
        "xyz_class"            text null check ("xyz_class" in ('X','Y','Z')),
        "abcxyz_class"         text null,
        "inv_usa"              integer not null default 0,
        "inv_china"            integer not null default 0,
        "qty_on_so"            integer not null default 0,
        "qty_on_po_usa"        integer not null default 0,
        "qty_on_po_china"      integer not null default 0,
        "qty_to_transfer"      integer not null default 0,
        "qty_to_factory"       integer not null default 0,
        "last_calculated_at"   timestamptz null,
        "created_at"           timestamptz not null default now(),
        "updated_at"           timestamptz not null default now(),
        constraint "purchasing_snapshot_pkey" primary key ("id")
      );
    `);
    this.addSql(`create unique index if not exists "UQ_snapshot_variant" on "purchasing_snapshot" ("variant_id");`);
    this.addSql(`create index if not exists "idx_snapshot_abc"    on "purchasing_snapshot" ("abc_class");`);
    this.addSql(`create index if not exists "idx_snapshot_abcxyz" on "purchasing_snapshot" ("abcxyz_class");`);

    // ── purchasing_sales_history ───────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchasing_sales_history" (
        "id"          text not null,
        "variant_id"  text not null,
        "month_date"  date not null,
        "qty_sold"    integer not null default 0,
        "revenue"     numeric(14,2) not null default 0,
        "source"      text not null default 'medusa_orders'
                        check ("source" in ('excel_import','medusa_orders')),
        "created_at"  timestamptz not null default now(),
        "updated_at"  timestamptz not null default now(),
        constraint "purchasing_sales_history_pkey" primary key ("id"),
        constraint "purchasing_sales_history_uq"
          unique ("variant_id", "month_date", "source")
      );
    `);
    this.addSql(`create index if not exists "idx_psh_variant_month" on "purchasing_sales_history" ("variant_id", "month_date");`);
    this.addSql(`create index if not exists "idx_psh_source"        on "purchasing_sales_history" ("source");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "purchasing_sales_history" cascade;`);
    this.addSql(`drop table if exists "purchasing_snapshot" cascade;`);
    this.addSql(`drop table if exists "purchasing_config" cascade;`);
    this.addSql(`drop table if exists "product_alternative" cascade;`);
  }
}
