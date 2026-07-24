import { Migration } from "@mikro-orm/migrations";

/**
 * China-agent regular Bills carry negative clearing Expense lines in QB that
 * have no standalone vendor_bill_line row in the POS. Persist their QB line
 * identity so a later BillMod can send the complete retained line set.
 *
 * Shape:
 * [{ kind, account_list_id, account_full_name, amount_cents, qb_txn_line_id }]
 */
export class Migration20260724150000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS qb_clearing_lines jsonb NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill DROP COLUMN IF EXISTS qb_clearing_lines;
    `);
  }
}
