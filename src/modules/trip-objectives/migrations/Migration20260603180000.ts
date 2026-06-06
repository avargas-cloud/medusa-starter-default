import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260603180000
 *
 * Bootstraps the trip-objectives module:
 *   - trip                         (a planned buying trip; one is_active)
 *   - trip_objective_category      (objective TYPE + dynamic field_schema/status_set)
 *   - trip_objective               (per-type structured fields + reference image)
 *   - trip_objective_observation   (dated notes + parties, FK to objective CASCADE)
 *
 * Status/priority use text columns (no Postgres ENUMs) to match the existing
 * module convention. JSONB columns hold the dynamic field schema + values.
 */
export class Migration20260603180000 extends Migration {
  override async up(): Promise<void> {
    // ── trip ──────────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "trip" (
        "id"                    text not null,
        "name"                  text not null,
        "destination"           text null,
        "starts_at"             timestamptz null,
        "ends_at"               timestamptz null,
        "timezone"              text not null default 'Asia/Shanghai',
        "status"                text not null default 'planned'
          check ("status" in ('planned','active','completed','archived')),
        "is_active"             boolean not null default false,
        "created_by_user_id"    text null,
        "created_at"            timestamptz not null default now(),
        "updated_at"            timestamptz not null default now(),
        "deleted_at"            timestamptz null,
        constraint "trip_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_trip_is_active" on "trip" ("is_active") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_deleted_at" on "trip" ("deleted_at") where deleted_at is null;`
    );

    // ── trip_objective_category ───────────────────────────────────────────
    this.addSql(`
      create table if not exists "trip_objective_category" (
        "id"                    text not null,
        "trip_id"               text null,
        "slug"                  text not null,
        "label"                 text not null,
        "icon_key"              text not null default 'target',
        "color_token"           text not null default 'slate',
        "field_schema"          jsonb null,
        "status_set"            jsonb null,
        "default_status_key"    text null,
        "position"              integer not null default 0,
        "is_active"             boolean not null default true,
        "created_at"            timestamptz not null default now(),
        "updated_at"            timestamptz not null default now(),
        "deleted_at"            timestamptz null,
        constraint "trip_objective_category_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_trip_objective_category_slug" on "trip_objective_category" ("slug") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_category_active" on "trip_objective_category" ("is_active") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_category_deleted_at" on "trip_objective_category" ("deleted_at") where deleted_at is null;`
    );

    // ── trip_objective ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "trip_objective" (
        "id"                          text not null,
        "trip_id"                     text not null,
        "category_id"                 text not null,
        "title"                       text not null,
        "description"                 text null,
        "status_key"                  text null,
        "priority"                    text not null default 'normal'
          check ("priority" in ('low','normal','high','urgent')),
        "reference_image_url"         text null,
        "reference_image_key"         text null,
        "reference_image_thumb_url"   text null,
        "reference_image_thumb_key"   text null,
        "product_variant_id"          text null,
        "product_sku"                 text null,
        "product_title"               text null,
        "product_thumbnail_url"       text null,
        "fields"                      jsonb null,
        "active_optional_fields"      jsonb null,
        "quotes"                      jsonb null,
        "metadata"                    jsonb null,
        "position"                    integer not null default 0,
        "created_by_user_id"          text null,
        "updated_by_user_id"          text null,
        "created_at"                  timestamptz not null default now(),
        "updated_at"                  timestamptz not null default now(),
        "deleted_at"                  timestamptz null,
        constraint "trip_objective_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_trip_objective_trip_cat" on "trip_objective" ("trip_id","category_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_trip_cat_pos" on "trip_objective" ("trip_id","category_id","position") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_status" on "trip_objective" ("status_key") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_deleted_at" on "trip_objective" ("deleted_at") where deleted_at is null;`
    );

    // ── trip_objective_observation ────────────────────────────────────────
    this.addSql(`
      create table if not exists "trip_objective_observation" (
        "id"                    text not null,
        "objective_id"          text not null,
        "occurred_at"           timestamptz not null,
        "note"                  text not null,
        "parties"               jsonb null,
        "created_by_user_id"    text null,
        "created_at"            timestamptz not null default now(),
        "updated_at"            timestamptz not null default now(),
        "deleted_at"            timestamptz null,
        constraint "trip_objective_observation_pkey" primary key ("id"),
        constraint "FK_trip_observation_objective"
          foreign key ("objective_id") references "trip_objective" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_trip_observation_objective" on "trip_objective_observation" ("objective_id","occurred_at" desc) where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_observation_deleted_at" on "trip_objective_observation" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "trip_objective_observation" cascade;`);
    this.addSql(`drop table if exists "trip_objective" cascade;`);
    this.addSql(`drop table if exists "trip_objective_category" cascade;`);
    this.addSql(`drop table if exists "trip" cascade;`);
  }
}
