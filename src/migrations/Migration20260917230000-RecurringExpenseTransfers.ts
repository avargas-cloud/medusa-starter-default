import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * calendar-rules-seed-20260917 — el Accounting Calendar produce también
 * TRANSFERENCIAS (pagos de tarjeta y de línea de crédito: Amex, Visa Regions,
 * Home Depot, Chase 7704). Para una regla `transfer`, `pay_from_account_list_id`
 * es la cuenta ORIGEN y `expense_account_list_id` guarda la cuenta DESTINO
 * (la tarjeta o el pasivo): no se agrega columna, cambia el significado y la
 * pantalla lo etiqueta "To account". El enlace apunta a `gl_transfer`.
 *
 * Sólo amplía los CHECKs (aditiva); `down` los devuelve a la lista anterior —
 * fallaría si quedara una fila `transfer`, y eso es a propósito.
 */
export class RecurringExpenseTransfers20260917230000 implements MigrationInterface {
  name = "RecurringExpenseTransfers20260917230000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      ALTER TABLE recurring_expense_rule
        DROP CONSTRAINT IF EXISTS rex_document_kind,
        ADD CONSTRAINT rex_document_kind CHECK (document_kind IN ('check','expense','bill','transfer'))
    `);
    await q.query(`
      ALTER TABLE recurring_expense_occurrence
        DROP CONSTRAINT IF EXISTS rexo_document_kind,
        ADD CONSTRAINT rexo_document_kind CHECK (document_kind IS NULL OR document_kind IN ('check','expense','bill','transfer')),
        DROP CONSTRAINT IF EXISTS rexo_matched_kind,
        ADD CONSTRAINT rexo_matched_kind CHECK (matched_kind IS NULL OR matched_kind IN ('gl_check','vendor_bill','gl_transfer'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE recurring_expense_occurrence
        DROP CONSTRAINT IF EXISTS rexo_matched_kind,
        ADD CONSTRAINT rexo_matched_kind CHECK (matched_kind IS NULL OR matched_kind IN ('gl_check','vendor_bill')),
        DROP CONSTRAINT IF EXISTS rexo_document_kind,
        ADD CONSTRAINT rexo_document_kind CHECK (document_kind IS NULL OR document_kind IN ('check','expense','bill'))
    `);
    await q.query(`
      ALTER TABLE recurring_expense_rule
        DROP CONSTRAINT IF EXISTS rex_document_kind,
        ADD CONSTRAINT rex_document_kind CHECK (document_kind IN ('check','expense','bill'))
    `);
  }
}
