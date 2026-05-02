import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Make pos_invoice.payment_method nullable.
 *
 * Why: invoices created via "Skip Payment" should not falsely advertise a
 * payment method (cash) before any actual payment is captured. The field is
 * populated when the first payment is applied via CapturePaymentModal.
 */
export class Migration20260502143000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice
      ALTER COLUMN payment_method DROP NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      UPDATE pos_invoice SET payment_method = 'cash' WHERE payment_method IS NULL;
    `);
    this.addSql(`
      ALTER TABLE pos_invoice
      ALTER COLUMN payment_method SET NOT NULL;
    `);
  }
}
