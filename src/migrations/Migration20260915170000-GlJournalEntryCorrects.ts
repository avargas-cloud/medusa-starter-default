import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * bankfeed-correct-20260915: un Journal Entry de RECLASIFICACIÓN (regla 3 de
 * docs/POLITICA_CORRECCIONES_CONTABLES.md — extracto cerrado, mismo monto, cuenta
 * equivocada) queda ENLAZADO al asiento que corrige: `corrects_entry_id` (el
 * `bank_journal_entry` original), `corrects_line_id` (su contralínea, la que se
 * reclasifica) y `corrects_match_id` (el `bank_statement_match` desde el que se
 * pidió). Sin el enlace no hay forma de topear cuánto se reclasificó ya de una
 * línea ni de mostrar "Reclasificado por JE-00xx" en la fila del Bank Feed; el
 * memo solo no es integridad.
 *
 * Expand-only: columnas nullable + un índice parcial de lectura; ningún lector
 * las exige.
 */
export class GlJournalEntryCorrects20260915170000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE gl_journal_entry ADD COLUMN IF NOT EXISTS corrects_entry_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE gl_journal_entry ADD COLUMN IF NOT EXISTS corrects_line_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE gl_journal_entry ADD COLUMN IF NOT EXISTS corrects_match_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE gl_journal_entry ADD COLUMN IF NOT EXISTS correction_type text NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_journal_entry_corrects_line ON gl_journal_entry(corrects_line_id) WHERE corrects_line_id IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_gl_journal_entry_corrects_line`);
    await queryRunner.query(`ALTER TABLE gl_journal_entry DROP COLUMN IF EXISTS correction_type`);
    await queryRunner.query(`ALTER TABLE gl_journal_entry DROP COLUMN IF EXISTS corrects_match_id`);
    await queryRunner.query(`ALTER TABLE gl_journal_entry DROP COLUMN IF EXISTS corrects_line_id`);
    await queryRunner.query(`ALTER TABLE gl_journal_entry DROP COLUMN IF EXISTS corrects_entry_id`);
  }
}
