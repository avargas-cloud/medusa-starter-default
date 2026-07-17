import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * qb_avg_cost_sync_run — durable tracking table for the manual "SYNC NOW" pull
 * of QuickBooks AverageCost into product_variant.metadata.qb_avg_cost. Enables
 * the POS "Cost Sync" progress card (poll-based, Bearer-auth).
 */
export class Migration20260717120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "qb_avg_cost_sync_run" (
      "id" text not null primary key,
      "status" text not null default 'queued',
      "scope" text not null default 'non_china',
      "total_count" integer not null default 0,
      "processed_count" integer not null default 0,
      "updated_count" integer not null default 0,
      "unchanged_count" integer not null default 0,
      "skipped_count" integer not null default 0,
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
      `create index if not exists "IDX_qb_avg_cost_sync_run_status" on "qb_avg_cost_sync_run" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_avg_cost_sync_run_created_at" on "qb_avg_cost_sync_run" ("created_at" desc) where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_avg_cost_sync_run_created_at";`);
    this.addSql(`drop index if exists "IDX_qb_avg_cost_sync_run_status";`);
    this.addSql(`drop table if exists "qb_avg_cost_sync_run";`);
  }
}
