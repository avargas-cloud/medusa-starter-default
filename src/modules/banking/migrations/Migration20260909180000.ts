import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { completionSchemaSql } from "../../../lib/banking/completion-schema";
import { completionClaimSql } from "../../../lib/banking/completion-claim-sql";
import { completionJournalSql } from "../../../lib/banking/completion-journal-sql";
import { completionMovementSql } from "../../../lib/banking/completion-movement-sql";

/** Additive V11; legacy v8/v9/v10 validation functions are preserved verbatim. */
export class Migration20260909180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(completionSchemaSql);
    this.addSql(completionClaimSql);
    this.addSql(completionJournalSql);
    this.addSql(completionMovementSql);
  }
  override async down(): Promise<void> {
    throw new Error("Banking completion history requires reviewed rollback; reverse journal entries instead.");
  }
}
