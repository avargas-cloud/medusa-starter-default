import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260326181604 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" add column if not exists "display_id" integer null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" drop column if exists "display_id";`
    );
  }
}
