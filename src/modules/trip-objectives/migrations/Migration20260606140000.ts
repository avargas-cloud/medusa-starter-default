import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260606140000
 *
 * Adds user-defined sub-groups to organize entries within a type:
 *   - trip_objective_category.groups   jsonb  [{ id, label, position }]
 *   - trip_objective.group_id          text   (one group per entry, nullable)
 *
 * Additive — the bootstrap migration (Migration20260603180000) is already
 * applied in prod, so this only ALTERs.
 */
export class Migration20260606140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "trip_objective_category" add column if not exists "groups" jsonb null;`
    );
    this.addSql(
      `alter table if exists "trip_objective" add column if not exists "group_id" text null;`
    );
    this.addSql(
      `create index if not exists "IDX_trip_objective_group" on "trip_objective" ("category_id","group_id") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_trip_objective_group";`);
    this.addSql(`alter table if exists "trip_objective" drop column if exists "group_id";`);
    this.addSql(`alter table if exists "trip_objective_category" drop column if exists "groups";`);
  }
}
