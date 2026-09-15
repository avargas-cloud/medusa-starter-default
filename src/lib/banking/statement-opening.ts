/**
 * Ancla de un extracto = el documento `opening_balance` de la cuenta en el GL. Tres formas:
 *
 *   1. OBE con línea `opening` → corte = día del OBE, saldo = esa línea (signo GL).
 *   2. OBE SIN línea `opening` (saldo $0 con partidas: el builder omite la línea de cero)
 *      → corte = día del OBE, saldo 0.
 *   3. SIN OBE — la cuenta no existía o estaba en $0 al corte contable, y el GL no admite un
 *      asiento de $0 (`validateLines`: `debit <= 0n` es GL_UNBALANCED_DOCUMENT). Se ancla en
 *      el corte del setup con saldo 0 y `opening_id` NULL, SÓLO si el libro tampoco tiene
 *      ningún asiento vivo sobre la cuenta hasta ese día: un libro con movimientos y sin
 *      apertura es una apertura que falta, no una apertura de cero (Visa 7914, 2026-09-15:
 *      tarjeta nueva en mayo, QB $0 al 2025-12-31, 69 movimientos, 26 docs).
 *
 * Puro: la consulta vive en `statementBank`; esto decide.
 */
import { BankingError } from "./security";

export type StatementOpening = {
  id: string | null;
  cut_date: string;
  statement_balance_cents: number;
};

export function resolveStatementOpening(input: {
  /** OBE vigente (kind='document', no reversado) de la cuenta, si existe. */
  obe: { id: string; day: string; opening_cents: number | null } | null;
  /** Asientos vivos sobre la cuenta (kind='document', no reversados) fechados ≤ `setup_cut_date`. */
  book_lines_at_cut: number;
  setup_cut_date: string;
}): StatementOpening {
  if (input.obe)
    return {
      id: input.obe.id,
      cut_date: input.obe.day,
      statement_balance_cents: input.obe.opening_cents ?? 0,
    };
  if (input.book_lines_at_cut !== 0)
    throw new BankingError("BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED", 409);
  return { id: null, cut_date: input.setup_cut_date, statement_balance_cents: 0 };
}
