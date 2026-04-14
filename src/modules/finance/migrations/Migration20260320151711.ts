import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260320151711 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" add column if not exists "medusa_payment_synced" boolean not null default false, add column if not exists "metadata" jsonb null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_payment" drop column if exists "medusa_payment_synced", drop column if exists "metadata";`
    );
  }
}
