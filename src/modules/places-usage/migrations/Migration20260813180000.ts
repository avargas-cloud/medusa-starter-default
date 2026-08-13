import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260813180000
 *
 * Bootstraps the places-usage module: one row per (day, source) counting calls
 * to Google Places, so the POS can show usage against the daily quota and — the
 * part that actually matters — surface the moment Google refuses a call because
 * the cap ran out.
 *
 * `day` is TEXT holding a YYYY-MM-DD **Pacific** date, not a DATE column and not
 * our timezone. Google Cloud quotas reset at midnight America/Los_Angeles; a
 * bucket keyed on anything else disagrees with the quota it tracks. Text keeps
 * the value unambiguous across the connection's timezone settings, which a DATE
 * would not.
 *
 * The UNIQUE(day, source) is what makes the atomic `ON CONFLICT DO UPDATE`
 * increment in the service possible — without it, concurrent lookups from
 * several cashiers would lose counts.
 *
 * `source` uses text + CHECK rather than a Postgres ENUM, matching the existing
 * module convention (inventory_count, qb_item_pipeline, price_change).
 */
export class Migration20260813180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "places_usage_daily" (
        "id"              text not null,
        "day"             text not null,
        "source"          text not null check ("source" in ('pos','web')),
        "lookups"         integer not null default 0,
        "details"         integer not null default 0,
        "quota_errors"    integer not null default 0,
        "other_errors"    integer not null default 0,
        "last_error_at"   timestamptz null,
        "last_error_code" text null,
        "created_at"      timestamptz not null default now(),
        "updated_at"      timestamptz not null default now(),
        "deleted_at"      timestamptz null,
        constraint "places_usage_daily_pkey" primary key ("id")
      );
    `);

    this.addSql(`
      create unique index if not exists "IDX_places_usage_daily_day_source"
        on "places_usage_daily" ("day", "source");
    `);

    // The Settings page reads "this month" as a prefix match on day.
    this.addSql(`
      create index if not exists "IDX_places_usage_daily_day"
        on "places_usage_daily" ("day");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "places_usage_daily" cascade;`);
  }
}
