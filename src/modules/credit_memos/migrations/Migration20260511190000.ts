import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260511190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo_item" add column if not exists "qb_txn_line_id" text null;`
    );
    this.addSql(
      `create index if not exists "IDX_pos_credit_memo_item_qb_txn_line_id" on "pos_credit_memo_item" ("qb_txn_line_id");`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_pos_credit_memo_item_qb_txn_line_id";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo_item" drop column if exists "qb_txn_line_id";`
    );
  }
}
