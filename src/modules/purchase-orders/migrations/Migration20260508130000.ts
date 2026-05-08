import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260508130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "vendor_bill"
        add column if not exists "vendor_id" text null,
        add column if not exists "vendor_name_snapshot" text null,
        add column if not exists "vendor_qb_list_id_snapshot" text null;
    `);

    this.addSql(`
      update "vendor_bill" vb
      set vendor_id = po.vendor_id,
          vendor_name_snapshot = po.vendor_name_snapshot,
          vendor_qb_list_id_snapshot = po.vendor_qb_list_id_snapshot
      from "purchase_order" po
      where vb.purchase_order_id = po.id
        and vb.vendor_id is null
        and vb.deleted_at is null
        and po.deleted_at is null;
    `);

    this.addSql(
      `create index if not exists "IDX_vb_vendor_id" on "vendor_bill" ("vendor_id") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_vb_vendor_id";`);
    this.addSql(`
      alter table "vendor_bill"
        drop column if exists "vendor_qb_list_id_snapshot",
        drop column if exists "vendor_name_snapshot",
        drop column if exists "vendor_id";
    `);
  }
}
