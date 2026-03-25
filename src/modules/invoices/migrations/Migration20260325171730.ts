import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260325171730 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pos_invoice" add column if not exists "metadata" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pos_invoice" drop column if exists "metadata";`);

    this.addSql(`alter table if exists "pos_invoice" drop column if exists "metadata";`);
  }

}
