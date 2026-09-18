import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * check-revise-20260918 — un `gl_check` POSTEADO se puede corregir en el lugar
 * (`reviseBankCheck`): reversa del asiento activo en su día original + asiento
 * nuevo, mismo documento, mismo CHK-####, `CheckMod` en QuickBooks.
 *
 * Estas columnas son la huella visible en el documento (el libro ya conserva
 * el historial completo por la cadena reversa → re-post). Expand-only: todas
 * nullable o con default, sin contract; `down` las quita.
 */
export class GlCheckRevision20260918150001 implements MigrationInterface {
  name = "GlCheckRevision20260918150001";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      ALTER TABLE gl_check
        ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS revised_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS revised_by text NULL,
        ADD COLUMN IF NOT EXISTS revision_reason text NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE gl_check
        DROP COLUMN IF EXISTS revision_reason,
        DROP COLUMN IF EXISTS revised_by,
        DROP COLUMN IF EXISTS revised_at,
        DROP COLUMN IF EXISTS revision
    `);
  }
}
