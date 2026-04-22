import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add retry/audit columns to qb_item_pipeline so EVERY item operation
 * (add or mod) is tracked end-to-end with retry semantics matching the
 * sales pipeline. Enables the pipeline poller to auto-retry failed rows
 * and the manual Retry button to faithfully resubmit Mod operations.
 */
export class Migration20260421200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "qb_item_pipeline"
        add column if not exists "op_action"     text default 'add',
        add column if not exists "op_payload"    jsonb null,
        add column if not exists "qb_id"         text null,
        add column if not exists "next_retry_at" timestamptz null,
        add column if not exists "failed_at"     timestamptz null;
    `);

    this.addSql(`
      create index if not exists "IDX_qb_item_pipeline_status_next_retry"
        on "qb_item_pipeline" ("status", "next_retry_at")
        where deleted_at is null;
    `);

    // Extend the status CHECK constraint to allow failed_permanent.
    this.addSql(`
      alter table "qb_item_pipeline"
        drop constraint if exists "qb_item_pipeline_status_check";
    `);
    this.addSql(`
      alter table "qb_item_pipeline"
        add constraint "qb_item_pipeline_status_check"
          check (status = any (array[
            'waiting'::text,
            'synced'::text,
            'error'::text,
            'failed_permanent'::text
          ]));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_qb_item_pipeline_status_next_retry";`
    );
    this.addSql(`
      alter table "qb_item_pipeline"
        drop column if exists "failed_at",
        drop column if exists "next_retry_at",
        drop column if exists "qb_id",
        drop column if exists "op_payload",
        drop column if exists "op_action";
    `);
  }
}
