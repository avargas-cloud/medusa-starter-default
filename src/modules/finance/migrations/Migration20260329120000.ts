import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260329120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`CREATE SEQUENCE IF NOT EXISTS pos_transaction_seq START 1000;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP SEQUENCE IF EXISTS pos_transaction_seq;`);
  }

}
