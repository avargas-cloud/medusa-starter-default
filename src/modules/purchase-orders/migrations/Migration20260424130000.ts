import { Migration } from "@mikro-orm/migrations";

/**
 * Adds a separate Postgres sequence for draft PO identifiers (D-{n}).
 * Drafts get D-{n} at creation; the real PO-{n} from custom_purchase_order_seq
 * is assigned only when the draft is submitted (approved). This prevents
 * AI-generated or exploratory drafts from consuming real PO sequence numbers.
 */
export class Migration20260424130000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE SEQUENCE IF NOT EXISTS custom_po_draft_seq START 1 INCREMENT 1;`
    );
  }

  async down(): Promise<void> {
    this.addSql(`DROP SEQUENCE IF EXISTS custom_po_draft_seq;`);
  }
}
