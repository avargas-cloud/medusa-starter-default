import { MigrationInterface, QueryRunner } from "typeorm";

import { journalReparentGuardSql } from "../lib/ledger/adopt/guard-sql";

import { functionBodiesOnly } from "./Migration20260915000000-BankingCardStatements";

/**
 * Adopción de documentos bancarios de QuickBooks (plan adopt-qb-bank-documents-20260915).
 *
 * Los cheques, gastos, cargos de tarjeta y traspasos de 2026 que el importador del
 * General Ledger trajo como `qb_import` pasan a `gl_check` / `gl_transfer` nativos
 * adoptando el TxnID, y el asiento existente se RE-PARENTA (misma fila, mismas
 * líneas, mismos matches, mismos extractos cerrados). Hasta hoy
 * `bank_journal_immutable()` rechazaba todo UPDATE de `bank_journal_entry`; desde acá
 * admite EXACTAMENTE tres aristas (adopt / revert / renumber) y sólo sobre
 * `source_kind`, `source_id`, `document_number`, `reference`, `description`,
 * `updated_at` — `lib/ledger/adopt/guard-sql.ts` explica cada una. Líneas, claims,
 * evidencias y las demás tablas que comparten la función siguen inmutables.
 *
 * `qb_source = 'adopted'` en `gl_check` / `gl_transfer` marca el documento que nació
 * de QuickBooks (el POS lo muestra con badge y el guard sólo re-parenta hacia/desde
 * documentos con esa marca).
 *
 * Sólo cuerpos de función (`CREATE OR REPLACE`), sin `DROP TRIGGER` (deadlock del
 * 2026-09-14). Expand-only: dos columnas nullable.
 */
export class GlAdoptQbImport20260916000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE gl_check ADD COLUMN IF NOT EXISTS qb_source text`);
    await queryRunner.query(`ALTER TABLE gl_transfer ADD COLUMN IF NOT EXISTS qb_source text`);
    await queryRunner.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_check_qb_source_check') THEN
           ALTER TABLE gl_check ADD CONSTRAINT gl_check_qb_source_check CHECK (qb_source IS NULL OR qb_source = 'adopted');
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_transfer_qb_source_check') THEN
           ALTER TABLE gl_transfer ADD CONSTRAINT gl_transfer_qb_source_check CHECK (qb_source IS NULL OR qb_source = 'adopted');
         END IF;
       END $$`
    );
    await queryRunner.query(functionBodiesOnly(journalReparentGuardSql));
  }

  public async down(): Promise<void> {
    throw new Error("bank_journal_immutable history requires reviewed rollback (adopted documents would lose their edge).");
  }
}
