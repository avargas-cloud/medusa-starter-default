import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateInvoiceSequence1774279173000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Start Invoices at 50000 to clearly distinguish from Drafts and Orders
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS custom_invoice_seq START 50000;`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS custom_invoice_seq;`);
  }
}
