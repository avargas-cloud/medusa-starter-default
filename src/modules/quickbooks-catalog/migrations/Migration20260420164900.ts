import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * qb_vendor_pipeline — tracks every bridge dispatch for vendor create/update.
 * Observability only: retry logic lives on the qb_vendor row itself.
 */
export class Migration20260420164900 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "qb_vendor_pipeline" (
      "id" text not null primary key,
      "vendor_id" text not null,
      "vendor_name" text not null,
      "op_type" text not null default 'create',
      "qb_operation_id" text null,
      "qb_list_id" text null,
      "status" text not null default 'waiting',
      "last_error" text null,
      "retries" integer not null default 0,
      "resolved_at" timestamptz null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null
    );`);

    this.addSql(
      `create index if not exists "IDX_qb_vendor_pipeline_status" on "qb_vendor_pipeline" ("status") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_pipeline_vendor_id" on "qb_vendor_pipeline" ("vendor_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_pipeline_qb_operation_id" on "qb_vendor_pipeline" ("qb_operation_id") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_vendor_pipeline_qb_operation_id";`);
    this.addSql(`drop index if exists "IDX_qb_vendor_pipeline_vendor_id";`);
    this.addSql(`drop index if exists "IDX_qb_vendor_pipeline_status";`);
    this.addSql(`drop table if exists "qb_vendor_pipeline";`);
  }
}
