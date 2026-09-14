import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Enlace a QuickBooks de los documentos GL bancarios (plan gl-docs-to-qb-20260914).
 *
 * Desde el 2026-09-12 el POS es el libro y `QB_SYNC_ENABLED` sigue encendido:
 * QuickBooks conserva la historia al día ESCRITA POR EL POS. Cheques/gastos
 * (`gl_check`), transfers (`gl_transfer`), asientos manuales (`gl_journal_entry`)
 * y depósitos (`bank_deposit`) se cargan en el POS y viajan por el
 * `qb_order_pipeline` (steps `gl_document_add` / `gl_document_void`). Estas
 * cuatro columnas son el espejo de lo que QuickBooks devolvió al confirmar el
 * ADD — la misma tripleta que llevan `vendor_bill_payment` y `vendor_credit`
 * (`qb_txn_id`, `qb_edit_sequence`, `qb_synced_at`) más `qb_txn_type`, porque
 * un mismo documento del POS puede materializarse como distinto tipo en QB
 * (un transfer con fee va como JournalEntry; un gl_check sobre tarjeta es un
 * CreditCardCharge) y el TxnVoid exige nombrar el tipo exacto que se creó.
 *
 * `qb_txn_id` NULL = no vive en QuickBooks (nunca se envió, o se anuló). El
 * historial de TxnIDs anulados queda en las filas del pipeline, y el importador
 * (`lib/ledger/qb-import/pos-links.ts`) los reconoce por ambas vías.
 *
 * Expand-only: cuatro columnas NULL-ables + un índice parcial por tabla para
 * la UNION del importador. Sin backfill: en producción hay 0 documentos de
 * estos cuatro tipos al 2026-09-14.
 */
const TABLES = ["gl_check", "gl_transfer", "gl_journal_entry", "bank_deposit"] as const;

export class GlDocumentsQbLink1789405000000 implements MigrationInterface {
  name = "GlDocumentsQbLink1789405000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS qb_txn_id text NULL`
      );
      await queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS qb_txn_type text NULL`
      );
      await queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS qb_edit_sequence text NULL`
      );
      await queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS qb_synced_at timestamptz NULL`
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_qb_txn_id ON ${table} (qb_txn_id) WHERE qb_txn_id IS NOT NULL`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`DROP INDEX IF EXISTS idx_${table}_qb_txn_id`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS qb_synced_at`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS qb_edit_sequence`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS qb_txn_type`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS qb_txn_id`);
    }
  }
}
