import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260602000000
 *
 * Adds two fields to inventory_count for programmatic (non-manual) counts:
 *
 *   source          — origin of the count: 'manual' (default, cashier-driven),
 *                     'qb_sync' (QB Desktop stock sync), 'china_sync' (China
 *                     warehouse bulk import). Used for UI badge differentiation
 *                     and filtering.
 *
 *   skip_qb_sync    — when true, the approve workflow omits enqueueQbAdjustments.
 *                     Set on counts whose inventory already came FROM QB — sending
 *                     it back would create a feedback loop.
 */
export class Migration20260602000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count"
         add column if not exists "source" text not null default 'manual',
         add column if not exists "skip_qb_sync" boolean not null default false;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "inventory_count"
         drop column if exists "source",
         drop column if exists "skip_qb_sync";`
    );
  }
}
