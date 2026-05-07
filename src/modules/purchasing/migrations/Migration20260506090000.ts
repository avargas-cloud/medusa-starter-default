import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Stores manual presentation groups for the POS Purchasing Analysis Elegant sort.
 */
export class Migration20260506090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "purchasing_analysis_group" (
        "id"         text not null,
        "category"   text not null,
        "title"      text not null,
        "sort_order" integer not null default 0,
        "is_active"  boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "purchasing_analysis_group_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "idx_pag_category_order" on "purchasing_analysis_group" ("category", "sort_order", "title") where "deleted_at" is null and "is_active" = true;`
    );

    this.addSql(`
      create table if not exists "purchasing_analysis_group_product" (
        "id"         text not null,
        "group_id"   text not null,
        "product_id" text not null,
        "sort_order" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "purchasing_analysis_group_product_pkey" primary key ("id"),
        constraint "purchasing_analysis_group_product_uq" unique ("group_id", "product_id")
      );
    `);
    this.addSql(
      `create index if not exists "idx_pagp_group_order" on "purchasing_analysis_group_product" ("group_id", "sort_order") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "idx_pagp_product" on "purchasing_analysis_group_product" ("product_id") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop table if exists "purchasing_analysis_group_product" cascade;`
    );
    this.addSql(`drop table if exists "purchasing_analysis_group" cascade;`);
  }
}
