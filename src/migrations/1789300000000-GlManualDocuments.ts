import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * GL manual documents — Journal Entries, Checks/Expenses/Card charges,
 * Transfers y el cierre de ejercicio (`year_close`).
 *
 * Expand-only:
 * 1. `bank_journal_entry_source_kind_check` recreado con la UNIÓN completa
 *    (core 1783300000000 + compras 1783500000000 + opening_balance
 *    1789000000000 + qb_import 1789200000000) + los 4 kinds manuales. Una
 *    lista parcial rompería los documentos existentes (hallado 2026-09-10).
 * 2. Tablas `gl_journal_entry(_line)`, `gl_check(_line)`, `gl_transfer` —
 *    el documento vive acá; el asiento vive en `bank_journal_entry` vía
 *    `postDocumentJournal` (`entry_id` apunta al asiento activo).
 * 3. Contadores gapless `gl_journal_entry`, `gl_check`, `gl_transfer` en
 *    `document_number_counter` (mismo mecanismo que `medusa_invoice`).
 * 4. Seed de `gl_account_map.retained_earnings` desde
 *    `qb_account.full_name = 'Retained Earnings'` — si no existe no se
 *    inserta nada: sólo el cierre de ejercicio falla con
 *    `GL_ACCOUNT_MAP_MISSING` (mismo criterio que `opening_balance_equity`).
 */
export class GlManualDocuments1789300000000 implements MigrationInterface {
  name = "GlManualDocuments1789300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN (
          'pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment',
          'po_receipt','vendor_bill','vendor_credit','vendor_bill_payment',
          'opening_balance','qb_import',
          'journal_entry','bank_check','bank_transfer','year_close'))
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_journal_entry (
        id text PRIMARY KEY,
        number text NOT NULL UNIQUE,
        day date NOT NULL,
        memo text,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
        entry_id text NULL,
        posted_at timestamptz NULL,
        voided_at timestamptz NULL,
        void_reason text NULL,
        evidence_id text NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_journal_entry_line (
        id text PRIMARY KEY,
        journal_entry_id text NOT NULL REFERENCES gl_journal_entry(id) ON DELETE CASCADE,
        sort_order integer NOT NULL,
        account_list_id text NOT NULL,
        account_snapshot jsonb NOT NULL,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        memo text,
        entity_type text NULL CHECK (entity_type IS NULL OR entity_type IN ('customer','vendor')),
        entity_id text NULL,
        entity_name text NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_journal_entry_line_je ON gl_journal_entry_line(journal_entry_id, sort_order)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_journal_entry_day_id ON gl_journal_entry(day, id) WHERE deleted_at IS NULL`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_check (
        id text PRIMARY KEY,
        number text NULL,
        doc_number text NOT NULL UNIQUE,
        kind text NOT NULL CHECK (kind IN ('check','expense','card_charge')),
        day date NOT NULL,
        bank_account_list_id text NOT NULL,
        bank_account_snapshot jsonb NOT NULL,
        payee_type text NOT NULL CHECK (payee_type IN ('vendor','customer','other')),
        payee_id text NULL,
        payee_name text NOT NULL,
        memo text,
        total_cents bigint NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
        entry_id text NULL,
        posted_at timestamptz NULL,
        voided_at timestamptz NULL,
        void_reason text NULL,
        to_be_printed boolean NOT NULL DEFAULT false,
        evidence_id text NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_check_line (
        id text PRIMARY KEY,
        check_id text NOT NULL REFERENCES gl_check(id) ON DELETE CASCADE,
        sort_order integer NOT NULL,
        account_list_id text NOT NULL,
        account_snapshot jsonb NOT NULL,
        amount_cents bigint NOT NULL,
        memo text,
        customer_id text NULL,
        billable boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_check_line_check ON gl_check_line(check_id, sort_order)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_check_day_id ON gl_check(day, id) WHERE deleted_at IS NULL`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_transfer (
        id text PRIMARY KEY,
        doc_number text NOT NULL UNIQUE,
        day date NOT NULL,
        from_account_list_id text NOT NULL,
        from_snapshot jsonb NOT NULL,
        to_account_list_id text NOT NULL,
        to_snapshot jsonb NOT NULL,
        amount_cents bigint NOT NULL CHECK (amount_cents > 0),
        memo text,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
        entry_id text NULL,
        posted_at timestamptz NULL,
        voided_at timestamptz NULL,
        void_reason text NULL,
        evidence_id text NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_transfer_day_id ON gl_transfer(day, id) WHERE deleted_at IS NULL`
    );

    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES ('gl_journal_entry', 0), ('gl_check', 0), ('gl_transfer', 0)
      ON CONFLICT (name) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO gl_account_map (key, qb_list_id, account_snapshot, allowed_types, label, updated_by)
      SELECT 'retained_earnings', a.qb_list_id,
        jsonb_build_object('id', a.qb_list_id, 'name', a.full_name, 'account_type', a.account_type, 'currency', 'USD'),
        ARRAY['Equity']::text[], 'Retained Earnings', 'migration-1789300000000'
      FROM qb_account a
      WHERE a.full_name = 'Retained Earnings' AND a.is_active = true AND a.account_type = 'Equity'
      ORDER BY a.last_synced_at DESC LIMIT 1
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM gl_account_map WHERE key = 'retained_earnings' AND updated_by = 'migration-1789300000000'`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS gl_transfer`);
    await queryRunner.query(`DROP TABLE IF EXISTS gl_check_line`);
    await queryRunner.query(`DROP TABLE IF EXISTS gl_check`);
    await queryRunner.query(`DROP TABLE IF EXISTS gl_journal_entry_line`);
    await queryRunner.query(`DROP TABLE IF EXISTS gl_journal_entry`);
    await queryRunner.query(
      `DELETE FROM document_number_counter WHERE name IN ('gl_journal_entry','gl_check','gl_transfer') AND value = 0`
    );
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
}
