import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260811120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "factory_order" add column if not exists "linked_purchase_order_id" text null;`
    );
    this.addSql(
      `create index if not exists "IDX_factory_order_linked_purchase_order_id" on "factory_order" ("linked_purchase_order_id") where "linked_purchase_order_id" is not null;`
    );
    this.addSql(
      `alter table if exists "factory_order_line" add column if not exists "purchase_order_line_id" text null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_factory_order_linked_purchase_order_id";`
    );
    this.addSql(
      `alter table if exists "factory_order" drop column if exists "linked_purchase_order_id";`
    );
    this.addSql(
      `alter table if exists "factory_order_line" drop column if exists "purchase_order_line_id";`
    );
  }
}
