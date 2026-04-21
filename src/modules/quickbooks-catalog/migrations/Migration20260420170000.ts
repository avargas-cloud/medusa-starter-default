import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * qb_vendor_sync_run — durable tracking table for the mass QB → Medusa
 * vendor sync. Enables progress reporting and restart-safe resumption.
 */
export class Migration20260420170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "qb_vendor_sync_run" (
      "id" text not null primary key,
      "status" text not null default 'queued',
      "bridge_operation_id" text null,
      "vendor_snapshot" jsonb null,
      "total_count" integer not null default 0,
      "processed_count" integer not null default 0,
      "created_count" integer not null default 0,
      "updated_count" integer not null default 0,
      "error_count" integer not null default 0,
      "started_at" timestamptz null,
      "completed_at" timestamptz null,
      "last_error" text null,
      "triggered_by_user_id" text null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null
    );`);

    this.addSql(
      `create index if not exists "IDX_qb_vendor_sync_run_status" on "qb_vendor_sync_run" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_sync_run_created_at" on "qb_vendor_sync_run" ("created_at" desc) where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_vendor_sync_run_created_at";`);
    this.addSql(`drop index if exists "IDX_qb_vendor_sync_run_status";`);
    this.addSql(`drop table if exists "qb_vendor_sync_run";`);
  }
}
