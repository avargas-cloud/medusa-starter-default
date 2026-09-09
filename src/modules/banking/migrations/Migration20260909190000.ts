import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { settlementSchemaSql } from "../../../lib/banking/settlement-schema";
import { completionMerchantSql } from "../../../lib/banking/completion-merchant-sql";
export class Migration20260909190000 extends Migration {
  override async up(): Promise<void> { this.addSql(settlementSchemaSql); this.addSql(completionMerchantSql); }
  override async down(): Promise<void> { throw new Error("Merchant accounting history requires an explicit reviewed rollback."); }
}
