import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260508120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "vendor_bill"
        alter column "purchase_order_receipt_id" drop not null,
        alter column "purchase_order_id" drop not null;
    `);
    this.addSql(`
      alter table "vendor_bill"
        add column if not exists "bill_type" text not null default 'regular'
          check ("bill_type" in ('regular','service','freight','tariff')),
        add column if not exists "service_vendor_bill_id" text null,
        add column if not exists "freight_vendor_bill_id" text null,
        add column if not exists "tariff_vendor_bill_id" text null;
    `);
    this.addSql(`
      alter table "vendor_bill_line"
        alter column "receipt_line_id" drop not null,
        alter column "product_variant_id" drop not null;
    `);
    this.addSql(`
      alter table "vendor_bill_line"
        add column if not exists "line_type" text not null default 'product'
          check ("line_type" in ('product','qb_account')),
        add column if not exists "qb_account_list_id" text null,
        add column if not exists "qb_account_full_name" text null,
        add column if not exists "qb_account_type" text null;
    `);
    this.addSql(
      `create index if not exists "IDX_vb_bill_type" on "vendor_bill" ("bill_type") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_vbl_line_type" on "vendor_bill_line" ("line_type") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_vbl_line_type";`);
    this.addSql(`drop index if exists "IDX_vb_bill_type";`);
    this.addSql(`
      alter table "vendor_bill_line"
        drop column if exists "qb_account_type",
        drop column if exists "qb_account_full_name",
        drop column if exists "qb_account_list_id",
        drop column if exists "line_type";
    `);
    this.addSql(`
      alter table "vendor_bill"
        drop column if exists "tariff_vendor_bill_id",
        drop column if exists "freight_vendor_bill_id",
        drop column if exists "service_vendor_bill_id",
        drop column if exists "bill_type";
    `);
  }
}
