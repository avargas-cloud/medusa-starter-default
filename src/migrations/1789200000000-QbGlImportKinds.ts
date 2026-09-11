import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * qb-gl-import §1 (docs/QB_GL_IMPORT.md) — `source_kind = 'qb_import'`:
 * documentos del libro importados del reporte General Ledger de QuickBooks
 * (`source_id` = TxnID de QB).
 *
 * Expand-only: recrea `bank_journal_entry_source_kind_check` con la UNIÓN de
 * todos los kinds vigentes (core 1783300000000 + compras 1783500000000 +
 * opening_balance 1789000000000) + `qb_import`. Una lista parcial rompería
 * los documentos existentes en producción (hallado 2026-09-10).
 */
export class QbGlImportKinds1789200000000 implements MigrationInterface {
  name = "QbGlImportKinds1789200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN (
          'pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment',
          'po_receipt','vendor_bill','vendor_credit','vendor_bill_payment',
          'opening_balance','qb_import'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN (
          'pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment',
          'po_receipt','vendor_bill','vendor_credit','vendor_bill_payment',
          'opening_balance'))
    `);
  }
}
