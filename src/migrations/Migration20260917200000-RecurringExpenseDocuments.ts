import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * calendar-workqueue-20260917 — el Accounting Calendar pasa de lista de
 * esperados a cola de trabajo: una ocurrencia puede ORIGINAR un documento
 * (check / expense / vendor bill) y quedar enlazada a él.
 *
 * · `recurring_expense_rule.document_kind` — qué documento produce la regla.
 * · La ocurrencia CONGELA además del monto todo lo que conduce el documento
 *   (kind, payee, cuenta de gasto, cuenta pagadora): editar la regla no puede
 *   reescribir el prefill de una ocurrencia pasada. Mismo principio que el
 *   snapshot de monto/tolerancia de la migración original.
 * · `due_date_override` — una ocurrencia movida de día a mano sobrevive a la
 *   re-materialización (que borra y regenera el futuro `expected`).
 * · Estado nuevo `booked`: existe un documento (draft o posted). `paid` sigue
 *   siendo manual; la pantalla DERIVA "paid" cuando el documento enlazado ya
 *   está posted/pagado. Invariantes: `booked` exige enlace; kind e id del
 *   enlace van juntos; un documento liquida a lo sumo UNA ocurrencia.
 *
 * Aditiva: columnas con default/null + índices. `down` la revierte entera.
 */
export class RecurringExpenseDocuments20260917200000 implements MigrationInterface {
  name = "RecurringExpenseDocuments20260917200000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      ALTER TABLE recurring_expense_rule
        ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'expense'
    `);
    await q.query(`
      ALTER TABLE recurring_expense_rule
        DROP CONSTRAINT IF EXISTS rex_document_kind,
        ADD CONSTRAINT rex_document_kind CHECK (document_kind IN ('check','expense','bill'))
    `);

    await q.query(`
      ALTER TABLE recurring_expense_occurrence
        ADD COLUMN IF NOT EXISTS document_kind text NULL,
        ADD COLUMN IF NOT EXISTS payee_type text NULL,
        ADD COLUMN IF NOT EXISTS payee_id text NULL,
        ADD COLUMN IF NOT EXISTS payee_name text NULL,
        ADD COLUMN IF NOT EXISTS expense_account_list_id text NULL,
        ADD COLUMN IF NOT EXISTS pay_from_account_list_id text NULL,
        ADD COLUMN IF NOT EXISTS due_date_override boolean NOT NULL DEFAULT false
    `);
    // Snapshot para lo que ya existía: desde la regla, sólo donde falta.
    await q.query(`
      UPDATE recurring_expense_occurrence o SET
        document_kind = r.document_kind,
        payee_type = r.payee_type,
        payee_id = r.payee_id,
        payee_name = r.payee_name,
        expense_account_list_id = r.expense_account_list_id,
        pay_from_account_list_id = r.pay_from_account_list_id
      FROM recurring_expense_rule r
      WHERE r.id = o.rule_id AND o.document_kind IS NULL
    `);
    await q.query(`
      ALTER TABLE recurring_expense_occurrence
        DROP CONSTRAINT IF EXISTS rexo_status,
        ADD CONSTRAINT rexo_status CHECK (status IN ('expected','booked','paid','skipped')),
        DROP CONSTRAINT IF EXISTS rexo_document_kind,
        ADD CONSTRAINT rexo_document_kind CHECK (document_kind IS NULL OR document_kind IN ('check','expense','bill')),
        DROP CONSTRAINT IF EXISTS rexo_matched_kind,
        ADD CONSTRAINT rexo_matched_kind CHECK (matched_kind IS NULL OR matched_kind IN ('gl_check','vendor_bill')),
        DROP CONSTRAINT IF EXISTS rexo_matched_pair,
        ADD CONSTRAINT rexo_matched_pair CHECK ((matched_kind IS NULL) = (matched_id IS NULL)),
        DROP CONSTRAINT IF EXISTS rexo_booked_linked,
        ADD CONSTRAINT rexo_booked_linked CHECK (status <> 'booked' OR matched_id IS NOT NULL)
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rexo_matched_document
        ON recurring_expense_occurrence (matched_kind, matched_id)
        WHERE matched_id IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_rexo_status_due ON recurring_expense_occurrence (status, due_date)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_rexo_status_due`);
    await q.query(`DROP INDEX IF EXISTS uq_rexo_matched_document`);
    await q.query(`
      ALTER TABLE recurring_expense_occurrence
        DROP CONSTRAINT IF EXISTS rexo_booked_linked,
        DROP CONSTRAINT IF EXISTS rexo_matched_pair,
        DROP CONSTRAINT IF EXISTS rexo_matched_kind,
        DROP CONSTRAINT IF EXISTS rexo_document_kind,
        DROP CONSTRAINT IF EXISTS rexo_status,
        ADD CONSTRAINT rexo_status CHECK (status IN ('expected','paid','skipped')),
        DROP COLUMN IF EXISTS due_date_override,
        DROP COLUMN IF EXISTS pay_from_account_list_id,
        DROP COLUMN IF EXISTS expense_account_list_id,
        DROP COLUMN IF EXISTS payee_name,
        DROP COLUMN IF EXISTS payee_id,
        DROP COLUMN IF EXISTS payee_type,
        DROP COLUMN IF EXISTS document_kind
    `);
    await q.query(`
      ALTER TABLE recurring_expense_rule
        DROP CONSTRAINT IF EXISTS rex_document_kind,
        DROP COLUMN IF EXISTS document_kind
    `);
  }
}
