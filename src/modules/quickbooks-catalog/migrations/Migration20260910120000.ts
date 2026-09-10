import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `seq` on qb_item_pipeline / qb_vendor_pipeline is a DB BIGSERIAL, but both
 * models DECLARE it (`model.number().nullable()`) so `query.graph` can return
 * it for the `#` column of the Item Sync / Vendor Sync tabs (aff3974b).
 *
 * Medusa's DML adds a BeforeCreate hook that sets every undefined nullable
 * property to `null`. MikroORM 6.4 dropped that null from the INSERT and the
 * serial default filled the column; MikroORM 6.6 (99e73535, Medusa 2.13→2.16)
 * sends it explicitly → `null value in column "seq" violates not-null` →
 * "Cannot set field 'seq' of Qb item pipeline to null" on EVERY item add/mod
 * and vendor create since the 2026-09-09 deploy.
 *
 * Fix at the DB: a BEFORE INSERT trigger assigns nextval() whenever seq comes
 * in NULL, regardless of which code path inserts (ORM, raw SQL, scripts) —
 * same pattern as tab_seq on qb_order_pipeline (1778300000000). Idempotent.
 */
export class Migration20260910120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function qb_pipeline_seq_default() returns trigger as $$
      begin
        if NEW.seq is null then
          NEW.seq := nextval(pg_get_serial_sequence(TG_TABLE_NAME, 'seq'));
        end if;
        return NEW;
      end;
      $$ language plpgsql;
    `);

    for (const table of ["qb_item_pipeline", "qb_vendor_pipeline"]) {
      this.addSql(`drop trigger if exists "trg_${table}_seq_default" on "${table}";`);
      this.addSql(`
        create trigger "trg_${table}_seq_default"
        before insert on "${table}"
        for each row execute function qb_pipeline_seq_default();
      `);
    }
  }

  override async down(): Promise<void> {
    for (const table of ["qb_item_pipeline", "qb_vendor_pipeline"]) {
      this.addSql(`drop trigger if exists "trg_${table}_seq_default" on "${table}";`);
    }
    this.addSql(`drop function if exists qb_pipeline_seq_default();`);
  }
}
