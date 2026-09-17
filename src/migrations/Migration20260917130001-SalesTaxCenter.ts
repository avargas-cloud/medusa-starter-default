import { MigrationInterface, QueryRunner } from "typeorm";

import { journalReparentGuardSql } from "../lib/ledger/adopt/guard-sql";

import { functionBodiesOnly } from "./Migration20260915000000-BankingCardStatements";

/**
 * Sales Tax Center (plan sales-tax-center-20260917).
 *
 * Dos documentos GL nativos nuevos, con la misma forma que `gl_check` /
 * `gl_transfer` (draft/posted/voided, `entry_id`, columnas espejo de QuickBooks,
 * `qb_source='adopted'` para los que nacieron en QB):
 *
 *   gl_sales_tax_payment (STP-####)   "Pay Sales Tax": Dr Sales Tax Payable / Cr banco
 *                                     por la remesa NETA; en QuickBooks es un
 *                                     SalesTaxPaymentCheck (línea del tax item por el
 *                                     bruto + líneas de ajuste sin item).
 *   gl_sales_tax_adjustment (STA-####) "Adjust Sales Tax Due": JournalEntry con el
 *                                     vendor (FL DOR) en la línea del payable.
 *
 * Más `sales_tax_return` (el snapshot CONGELADO de una declaración DR-15 por período)
 * y `sales_tax_settings` (una fila: tax item, vendor, banco default, tolerancia).
 *
 * Expand-only: tablas nuevas, dos `source_kind` más en el CHECK del journal
 * (mismo procedimiento NOT VALID + VALIDATE que `GlBankDeposits`), dos counters y
 * los cuerpos de función del guard de re-parent con las dos tablas nuevas.
 */
export class SalesTaxCenter20260917130001 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // 1. source_kind CHECK += sales_tax_payment, sales_tax_adjustment
    const rows = (await q.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'bank_journal_entry_source_kind_check'`
    )) as Array<{ def: string }>;
    const current = new Set(
      Array.from((rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g), (m) => m[1])
    );
    if (current.size === 0) {
      throw new Error(
        "SalesTaxCenter20260917130001: bank_journal_entry_source_kind_check not found or unparsable — refusing to guess the kind list"
      );
    }
    current.add("sales_tax_payment");
    current.add("sales_tax_adjustment");
    const list = [...current].map((k) => `'${k}'`).join(", ");
    await q.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await q.query(
      `ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check CHECK (source_kind IN (${list})) NOT VALID`
    );
    await q.query(
      `ALTER TABLE bank_journal_entry VALIDATE CONSTRAINT bank_journal_entry_source_kind_check`
    );

    // 2. settings (una fila)
    await q.query(`
      CREATE TABLE IF NOT EXISTS sales_tax_settings (
        id text PRIMARY KEY,
        tax_item_list_id text NULL,
        tax_item_name text NULL,
        vendor_list_id text NULL,
        vendor_name text NULL,
        default_bank_account_list_id text NULL,
        filing_frequency text NOT NULL DEFAULT 'monthly' CHECK (filing_frequency IN ('monthly')),
        state_rate_bp integer NOT NULL DEFAULT 600,
        surtax_rate_bp integer NOT NULL DEFAULT 100,
        variance_tolerance_cents bigint NOT NULL DEFAULT 500,
        updated_by text NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `INSERT INTO sales_tax_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`
    );

    // 3. la declaración congelada por período
    await q.query(`
      CREATE TABLE IF NOT EXISTS sales_tax_return (
        id text PRIMARY KEY,
        period text NOT NULL UNIQUE CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
        status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','filed')),
        figures jsonb NOT NULL,
        cutoff_at timestamptz NOT NULL,
        prepared_by text NOT NULL,
        prepared_at timestamptz NOT NULL DEFAULT now(),
        filed_by text NULL,
        filed_at timestamptz NULL,
        confirmation_number text NULL,
        filed_amount_cents bigint NULL,
        notes text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 4. ajustes (STA)
    await q.query(`
      CREATE TABLE IF NOT EXISTS gl_sales_tax_adjustment (
        id text PRIMARY KEY,
        doc_number text NOT NULL UNIQUE,
        period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
        day date NOT NULL,
        type text NOT NULL CHECK (type IN ('collection_allowance','penalty','interest','rounding','prior_credit','other')),
        direction text NOT NULL CHECK (direction IN ('decrease','increase')),
        amount_cents bigint NOT NULL CHECK (amount_cents > 0),
        payable_list_id text NOT NULL,
        payable_snapshot jsonb NOT NULL,
        offset_account_list_id text NOT NULL,
        offset_snapshot jsonb NOT NULL,
        vendor_list_id text NULL,
        vendor_name text NULL,
        reason text NULL,
        memo text NULL,
        applied_payment_id text NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
        entry_id text NULL,
        posted_at timestamptz NULL,
        voided_at timestamptz NULL,
        void_reason text NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        qb_txn_id text NULL,
        qb_txn_type text NULL,
        qb_edit_sequence text NULL,
        qb_synced_at timestamptz NULL,
        qb_source text NULL CHECK (qb_source IS NULL OR qb_source = 'adopted')
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_sales_tax_adjustment_period ON gl_sales_tax_adjustment(period, day) WHERE deleted_at IS NULL`
    );

    // 5. pagos (STP) + líneas
    await q.query(`
      CREATE TABLE IF NOT EXISTS gl_sales_tax_payment (
        id text PRIMARY KEY,
        doc_number text NOT NULL UNIQUE,
        period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
        day date NOT NULL,
        bank_account_list_id text NOT NULL,
        bank_account_snapshot jsonb NOT NULL,
        payable_list_id text NOT NULL,
        payable_snapshot jsonb NOT NULL,
        vendor_list_id text NULL,
        vendor_name text NOT NULL,
        tax_item_list_id text NULL,
        tax_item_name text NULL,
        tax_cents bigint NOT NULL CHECK (tax_cents > 0),
        adjustments_cents bigint NOT NULL DEFAULT 0,
        total_cents bigint NOT NULL CHECK (total_cents > 0),
        reference text NULL,
        memo text NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
        entry_id text NULL,
        posted_at timestamptz NULL,
        voided_at timestamptz NULL,
        void_reason text NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        qb_txn_id text NULL,
        qb_txn_type text NULL,
        qb_edit_sequence text NULL,
        qb_synced_at timestamptz NULL,
        qb_source text NULL CHECK (qb_source IS NULL OR qb_source = 'adopted')
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS gl_sales_tax_payment_line (
        id text PRIMARY KEY,
        payment_id text NOT NULL REFERENCES gl_sales_tax_payment(id) ON DELETE CASCADE,
        sort_order integer NOT NULL,
        kind text NOT NULL CHECK (kind IN ('tax','adjustment')),
        item_sales_tax_list_id text NULL,
        adjustment_id text NULL REFERENCES gl_sales_tax_adjustment(id),
        amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
        memo text NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_sales_tax_payment_line_payment ON gl_sales_tax_payment_line(payment_id, sort_order)`
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_sales_tax_payment_period ON gl_sales_tax_payment(period, day) WHERE deleted_at IS NULL`
    );
    // Un solo pago VIVO (draft o posted) por período: el segundo "Record payment"
    // del mismo mes es un error de operación, no un caso de negocio.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_sales_tax_payment_period_live ON gl_sales_tax_payment(period)
        WHERE deleted_at IS NULL AND status <> 'voided'`
    );

    // 6. counters
    await q.query(
      `INSERT INTO document_number_counter (name, value)
        VALUES ('gl_sales_tax_payment', 0), ('gl_sales_tax_adjustment', 0)
        ON CONFLICT (name) DO NOTHING`
    );

    // 7. guard de re-parent con las dos tablas nuevas (sólo cuerpos de función)
    await q.query(functionBodiesOnly(journalReparentGuardSql));
  }

  public async down(): Promise<void> {
    throw new Error(
      "SalesTaxCenter: expand-only migration; documents and returns would lose their journal edge on rollback."
    );
  }
}
