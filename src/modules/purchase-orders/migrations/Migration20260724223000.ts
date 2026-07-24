import { Migration } from "@mikro-orm/migrations";

export class Migration20260724223000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS qb_is_paid boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS qb_balance_remaining_cents integer NULL,
        ADD COLUMN IF NOT EXISTS qb_payment_checked_at timestamptz NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP COLUMN IF EXISTS qb_payment_checked_at,
        DROP COLUMN IF EXISTS qb_balance_remaining_cents,
        DROP COLUMN IF EXISTS qb_is_paid;
    `);
  }
}
