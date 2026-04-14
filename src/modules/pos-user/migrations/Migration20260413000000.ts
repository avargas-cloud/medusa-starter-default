import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260413000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "pos_user" add column if not exists "can_view_accounting" boolean not null default false;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "pos_user" drop column if exists "can_view_accounting";`
    );
  }
}
