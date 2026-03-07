import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260307022654 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "pos_user" ("id" text not null, "email" text not null, "first_name" text null, "last_name" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pos_user_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pos_user_deleted_at" ON "pos_user" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "pos_user" cascade;`);
  }

}
