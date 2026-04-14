import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260414000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo" add column if not exists "sales_rep" jsonb null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo" drop column if exists "sales_rep";`
    );
  }
}
