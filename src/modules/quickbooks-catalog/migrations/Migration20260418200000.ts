import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260418200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "qb_vendor"
      add column if not exists "sync_status" text null,
      add column if not exists "qb_operation_id" text null,
      add column if not exists "last_error" text null,
      add column if not exists "resolved_at" timestamptz null;`);

    this.addSql(
      `create index if not exists "IDX_qb_vendor_sync_status" on "qb_vendor" ("sync_status") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_vendor_sync_status";`);
    this.addSql(`alter table "qb_vendor"
      drop column if exists "resolved_at",
      drop column if exists "last_error",
      drop column if exists "qb_operation_id",
      drop column if exists "sync_status";`);
  }
}
