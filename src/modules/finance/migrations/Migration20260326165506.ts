import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260326165506 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "qb_bank_account" drop constraint if exists "qb_bank_account_list_id_unique";`);
    this.addSql(`create table if not exists "qb_bank_account" ("id" text not null, "name" text not null, "list_id" text not null, "type" text check ("type" in ('Bank', 'CreditCard', 'OtherCurrentAsset')) not null default 'Bank', "is_active" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "qb_bank_account_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_qb_bank_account_list_id_unique" ON "qb_bank_account" ("list_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_qb_bank_account_deleted_at" ON "qb_bank_account" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "qb_bank_account" cascade;`);
  }

}
