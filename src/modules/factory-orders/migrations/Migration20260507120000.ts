import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260507120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "factory_order" add column if not exists "metadata" jsonb null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "factory_order" drop column if exists "metadata";`
    );
  }
}
