import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260129194325 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "attribute_set" drop constraint if exists "attribute_set_handle_unique";`
    );
    this.addSql(
      `create table if not exists "attribute_set" ("id" text not null, "handle" text not null, "title" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "attribute_set_pkey" primary key ("id"));`
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_attribute_set_handle_unique" ON "attribute_set" ("handle") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_attribute_set_deleted_at" ON "attribute_set" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    this.addSql(
      `alter table if exists "attribute_key" add column if not exists "display_name" text null, add column if not exists "description" text null, add column if not exists "filter_type" text null, add column if not exists "filter_order" integer null, add column if not exists "icon" text null, add column if not exists "unit" text null, add column if not exists "attribute_set_id" text null;`
    );
    this.addSql(
      `alter table if exists "attribute_key" add constraint "attribute_key_attribute_set_id_foreign" foreign key ("attribute_set_id") references "attribute_set" ("id") on update cascade on delete set null;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_attribute_key_attribute_set_id" ON "attribute_key" ("attribute_set_id") WHERE deleted_at IS NULL;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "attribute_key" drop constraint if exists "attribute_key_attribute_set_id_foreign";`
    );

    this.addSql(`drop table if exists "attribute_set" cascade;`);

    this.addSql(`drop index if exists "IDX_attribute_key_attribute_set_id";`);
    this.addSql(
      `alter table if exists "attribute_key" drop column if exists "display_name", drop column if exists "description", drop column if exists "filter_type", drop column if exists "filter_order", drop column if exists "icon", drop column if exists "unit", drop column if exists "attribute_set_id";`
    );
  }
}
