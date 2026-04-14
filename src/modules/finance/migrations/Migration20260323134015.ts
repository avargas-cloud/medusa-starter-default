import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260323134015 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" add column if not exists "qb" jsonb null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" drop column if exists "qb";`
    );
  }
}
