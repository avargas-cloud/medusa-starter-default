import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260406000001 extends Migration {

  override async up(): Promise<void> {
    // Add damaged_qty to credit memo items (units returned but NOT restocked — defective)
    this.addSql(`alter table if exists "pos_credit_memo_item" add column if not exists "damaged_qty" integer not null default 0;`);

    // Tracking table for damaged/defective returned products
    this.addSql(`
      create table if not exists "pos_damaged_item" (
        "id"            text not null,
        "credit_memo_id" text not null,
        "order_id"      text null,
        "variant_id"    text null,
        "sku"           text null,
        "title"         text null,
        "quantity"      integer not null,
        "unit_price"    numeric not null default 0,
        "created_at"    timestamptz not null default now(),
        constraint "pos_damaged_item_pkey" primary key ("id")
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pos_damaged_item_credit_memo_id" ON "pos_damaged_item" ("credit_memo_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pos_damaged_item_sku" ON "pos_damaged_item" ("sku") WHERE sku IS NOT NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pos_damaged_item_variant_id" ON "pos_damaged_item" ("variant_id") WHERE variant_id IS NOT NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pos_credit_memo_item" drop column if exists "damaged_qty";`);
    this.addSql(`drop table if exists "pos_damaged_item";`);
  }

}
