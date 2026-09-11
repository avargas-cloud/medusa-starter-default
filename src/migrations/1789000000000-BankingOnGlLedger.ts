import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Banking-on-GL §2/§3/§6 — documento `opening_balance` del GL.
 *
 * Expand-only, dos cambios:
 * 1. `bank_journal_entry_source_kind_check` += `'opening_balance'` — el
 *    mismo CHECK que `1783300000000-GeneralLedgerCore` creó, con un valor
 *    más en la lista (recrear el CHECK completo es la única forma de
 *    agregarle un valor a un `IN (...)`).
 * 2. Seed de `gl_account_map` para la key `opening_balance_equity` desde
 *    `qb_account.full_name = 'Opening Balance Equity'`. Si esa cuenta no
 *    existe en el ambiente, NO se inserta ninguna fila (mismo criterio que
 *    el seed de `GeneralLedgerCore`): `loadAccountMap` con la key opcional
 *    (§6, diseño) hace que sólo falle el posting de `opening_balance`
 *    (`GL_ACCOUNT_MAP_MISSING`), nunca los documentos existentes.
 */
export class BankingOnGlLedger1789000000000 implements MigrationInterface {
  name = "BankingOnGlLedger1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN ('pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment','opening_balance'))
    `);

    await queryRunner.query(
      `
      INSERT INTO gl_account_map (key, qb_list_id, account_snapshot, allowed_types, label, updated_by)
      SELECT 'opening_balance_equity', a.qb_list_id,
        jsonb_build_object('id', a.qb_list_id, 'name', a.full_name, 'account_type', a.account_type, 'currency', 'USD'),
        ARRAY['Equity']::text[], 'Opening Balance Equity', 'migration-1789000000000'
      FROM qb_account a
      WHERE a.full_name = 'Opening Balance Equity' AND a.is_active = true AND a.account_type = 'Equity'
      ORDER BY a.last_synced_at DESC LIMIT 1
      ON CONFLICT (key) DO NOTHING
      `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM gl_account_map WHERE key = 'opening_balance_equity' AND updated_by = 'migration-1789000000000'`
    );

    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN ('pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment'))
    `);
  }
}
