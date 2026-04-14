import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds invoice_number to payment_application.
 * This is the human-readable POS invoice number (e.g. "30033") stored
 * directly on the application record so the payments UI can display
 * the invoice reference without cross-module joins.
 */
export class AddInvoiceNumberToPaymentApplication1744048000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE payment_application
            ADD COLUMN IF NOT EXISTS invoice_number TEXT
        `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE payment_application
            DROP COLUMN IF EXISTS invoice_number
        `);
  }
}
