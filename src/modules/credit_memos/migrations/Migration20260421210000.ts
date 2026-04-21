import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260421210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo" add column if not exists "refund_method" text null;`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" drop constraint if exists "pos_credit_memo_refund_method_check";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" add constraint "pos_credit_memo_refund_method_check" check ("refund_method" is null or "refund_method" in ('store_credit','refund'));`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo" drop constraint if exists "pos_credit_memo_refund_method_check";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" drop column if exists "refund_method";`
    );
  }
}
