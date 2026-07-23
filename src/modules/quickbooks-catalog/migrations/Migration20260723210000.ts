import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * qb_vendor_sync_run — payment-terms resync support.
 *
 * `mode` splits the existing full vendor pull (the /vendors "Sync from QB"
 * button) from the new terms-only pull (Settings → QuickBooks Sync → "Resync
 * Payment Terms"), which writes ONLY the QB term name + its due-days onto each
 * vendor. Both share the same runner, chunking and progress counters.
 *
 * The terms_* columns hold the parallel QB Terms query (name → StdDueDays):
 * QB Vendors carry only the term NAME, so the days come from the Terms list.
 */
export class Migration20260723210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "qb_vendor_sync_run"
      add column if not exists "mode" text not null default 'full',
      add column if not exists "terms_operation_id" text null,
      add column if not exists "terms_snapshot" jsonb null,
      add column if not exists "terms_written_count" integer not null default 0,
      add column if not exists "terms_skipped_count" integer not null default 0;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "qb_vendor_sync_run"
      drop column if exists "terms_skipped_count",
      drop column if exists "terms_written_count",
      drop column if exists "terms_snapshot",
      drop column if exists "terms_operation_id",
      drop column if exists "mode";`);
  }
}
