import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260811235000
 *
 * Adds the `draft` status to price_change_batch and makes `submitted_at`
 * nullable — a draft is work-in-progress that hasn't been submitted yet, so
 * it has no submitted_at until POST /:id/submit sets it.
 *
 * The CHECK constraint dropped/recreated here is the inline, unnamed one
 * from Migration20260811190000 (`check ("status" in (...))` with no explicit
 * constraint name) — Postgres names that `price_change_batch_status_check`
 * by convention (`<table>_<column>_check`), so that's the name being
 * replaced.
 */
export class Migration20260811235000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table if exists "price_change_batch"
        drop constraint if exists "price_change_batch_status_check";
    `);
    this.addSql(`
      alter table if exists "price_change_batch"
        add constraint "price_change_batch_status_check"
        check ("status" in ('draft','submitted','approved','rejected'));
    `);
    this.addSql(`
      alter table if exists "price_change_batch"
        alter column "submitted_at" drop not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table if exists "price_change_batch"
        drop constraint if exists "price_change_batch_status_check";
    `);
    this.addSql(`
      alter table if exists "price_change_batch"
        add constraint "price_change_batch_status_check"
        check ("status" in ('submitted','approved','rejected'));
    `);
    this.addSql(`
      alter table if exists "price_change_batch"
        alter column "submitted_at" set not null;
    `);
  }
}
