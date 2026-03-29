import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260329000001 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pos_credit_memo" add column if not exists "shipping_option_id" text null;`);
    this.addSql(`alter table if exists "pos_credit_memo" add column if not exists "shipping_option_name" text null;`);
    this.addSql(`alter table if exists "pos_credit_memo" add column if not exists "qb_txn_id" text null;`);
    this.addSql(`alter table if exists "pos_credit_memo" add column if not exists "qb_edit_sequence" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pos_credit_memo" drop column if exists "shipping_option_id";`);
    this.addSql(`alter table if exists "pos_credit_memo" drop column if exists "shipping_option_name";`);
    this.addSql(`alter table if exists "pos_credit_memo" drop column if exists "qb_txn_id";`);
    this.addSql(`alter table if exists "pos_credit_memo" drop column if exists "qb_edit_sequence";`);
  }

}
