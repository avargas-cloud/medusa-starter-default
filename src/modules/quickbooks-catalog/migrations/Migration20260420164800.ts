import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Vendor retry/backoff fields.
 *
 *   retry_count     — how many times the poller has retried this row.
 *   next_retry_at   — NULL = eligible immediately; otherwise earliest retry time.
 *
 * sync_status gains a new "failed_permanent" value (string-stored, no enum).
 */
export class Migration20260420164800 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "qb_vendor"
      add column if not exists "retry_count" integer not null default 0,
      add column if not exists "next_retry_at" timestamptz null;`);

    this.addSql(
      `create index if not exists "IDX_qb_vendor_next_retry_at" on "qb_vendor" ("next_retry_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_vendor_next_retry_at";`);
    this.addSql(`alter table "qb_vendor"
      drop column if exists "next_retry_at",
      drop column if exists "retry_count";`);
  }
}
