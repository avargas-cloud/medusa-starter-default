import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260318194255 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pos_invoice" drop constraint if exists "pos_invoice_status_check";`);

    this.addSql(`alter table if exists "pos_invoice" add column if not exists "discount" numeric not null default 0, add column if not exists "shipping" integer not null default 0, add column if not exists "shipping_address" jsonb null, add column if not exists "raw_discount" jsonb not null default '{"value":"0","precision":20}';`);
    this.addSql(`alter table if exists "pos_invoice" add constraint "pos_invoice_status_check" check("status" in ('draft', 'issued', 'partial', 'paid', 'voided'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pos_invoice" drop constraint if exists "pos_invoice_status_check";`);

    this.addSql(`alter table if exists "pos_invoice" drop column if exists "discount", drop column if exists "shipping", drop column if exists "shipping_address", drop column if exists "raw_discount";`);

    this.addSql(`alter table if exists "pos_invoice" add constraint "pos_invoice_status_check" check("status" in ('draft', 'issued', 'paid', 'voided'));`);
  }

}
