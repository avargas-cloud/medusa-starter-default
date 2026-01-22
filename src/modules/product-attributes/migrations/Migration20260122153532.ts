import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260122153532 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "attribute_key" drop constraint if exists "attribute_key_handle_unique";`);
    this.addSql(`create table if not exists "attribute_key" ("id" text not null, "handle" text not null, "label" text not null, "options" text[] null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "attribute_key_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_attribute_key_handle_unique" ON "attribute_key" ("handle") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_attribute_key_deleted_at" ON "attribute_key" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "attribute_value" ("id" text not null, "value" text not null, "attribute_key_id" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "attribute_value_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_attribute_value_attribute_key_id" ON "attribute_value" ("attribute_key_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_attribute_value_deleted_at" ON "attribute_value" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "attribute_value" add constraint "attribute_value_attribute_key_id_foreign" foreign key ("attribute_key_id") references "attribute_key" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "attribute_value" drop constraint if exists "attribute_value_attribute_key_id_foreign";`);

    this.addSql(`drop table if exists "attribute_key" cascade;`);

    this.addSql(`drop table if exists "attribute_value" cascade;`);
  }

}
