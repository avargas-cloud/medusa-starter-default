import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * qb-other-names-picker-20260916: la lista **Other Names** de QuickBooks
 * (Amerant Bank, Chase Bank, SBA EIDL… — 46 al 09/16/2026) cacheada en el
 * POS, igual que `qb_account` cachea el Chart of Accounts. Se carga desde el
 * bridge (`POST /admin/qb-catalog/other-names/sync`, OtherNameQueryRq) y el
 * POS NUNCA crea nombres en QB: sólo elige entre los que existen.
 *
 * Con ella, un asiento manual o un cheque pueden enlazar un nombre que no es
 * vendor ni customer: `entity_type` / `payee_type` = 'other_name', con el id
 * de esta tabla, y `facts.ts` lo manda a QB como EntityRef / PayeeEntityRef.
 * 'other' (texto libre) sigue existiendo — un nombre que QB no conoce viaja
 * en el memo, como hasta hoy.
 */
export class QbOtherNames20260916150000 implements MigrationInterface {
  name = "QbOtherNames20260916150000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS qb_other_name (
        id             text PRIMARY KEY,
        qb_list_id     text NOT NULL,
        name           text NOT NULL,
        is_active      boolean NOT NULL DEFAULT true,
        edit_sequence  text NULL,
        company_name   text NULL,
        metadata       jsonb NULL,
        last_synced_at timestamptz NOT NULL DEFAULT now(),
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        deleted_at     timestamptz NULL,
        CONSTRAINT uq_qb_other_name_list_id UNIQUE (qb_list_id)
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_other_name_active ON qb_other_name (lower(name)) WHERE is_active = true AND deleted_at IS NULL`
    );

    await q.query(`ALTER TABLE gl_journal_entry_line DROP CONSTRAINT IF EXISTS gl_journal_entry_line_entity_type_check`);
    await q.query(
      `ALTER TABLE gl_journal_entry_line ADD CONSTRAINT gl_journal_entry_line_entity_type_check
         CHECK (entity_type IS NULL OR entity_type IN ('customer','vendor','other_name'))`
    );
    await q.query(`ALTER TABLE gl_check DROP CONSTRAINT IF EXISTS gl_check_payee_type_check`);
    await q.query(
      `ALTER TABLE gl_check ADD CONSTRAINT gl_check_payee_type_check
         CHECK (payee_type IN ('vendor','customer','other','other_name'))`
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Un documento enlazado a un Other Name vuelve a texto libre antes de
    // estrechar los CHECK, para que el down nunca falle a mitad.
    await q.query(`UPDATE gl_check SET payee_type = 'other', payee_id = NULL WHERE payee_type = 'other_name'`);
    await q.query(`UPDATE gl_journal_entry_line SET entity_type = NULL, entity_id = NULL WHERE entity_type = 'other_name'`);
    await q.query(`ALTER TABLE gl_check DROP CONSTRAINT IF EXISTS gl_check_payee_type_check`);
    await q.query(
      `ALTER TABLE gl_check ADD CONSTRAINT gl_check_payee_type_check CHECK (payee_type IN ('vendor','customer','other'))`
    );
    await q.query(`ALTER TABLE gl_journal_entry_line DROP CONSTRAINT IF EXISTS gl_journal_entry_line_entity_type_check`);
    await q.query(
      `ALTER TABLE gl_journal_entry_line ADD CONSTRAINT gl_journal_entry_line_entity_type_check
         CHECK (entity_type IS NULL OR entity_type IN ('customer','vendor'))`
    );
    await q.query(`DROP TABLE IF EXISTS qb_other_name`);
  }
}
