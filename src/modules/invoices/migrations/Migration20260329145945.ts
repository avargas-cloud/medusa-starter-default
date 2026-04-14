import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260329145945 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_invoice" add column if not exists "untaxed_total" numeric not null default 0;`
    );
    this.addSql(
      `alter table if exists "pos_invoice" add column if not exists "raw_untaxed_total" jsonb null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_invoice" drop column if exists "untaxed_total";`
    );
    this.addSql(
      `alter table if exists "pos_invoice" drop column if exists "raw_untaxed_total";`
    );
  }
}
