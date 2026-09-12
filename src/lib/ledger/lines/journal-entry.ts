import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export interface JournalEntryLineInput {
  account: LedgerAccount;
  debit_cents: bigint;
  credit_cents: bigint;
  memo?: string | null;
}

export const JOURNAL_ENTRY_MIN_LINES = 2;
export const JOURNAL_ENTRY_MAX_LINES = 200;

/**
 * Builder puro del documento `journal_entry`: las líneas van tal cual las
 * escribió el contador. Reglas: 2..200 líneas, cada una con UN solo lado
 * > 0, ninguna cuenta NonPosting, Σdebit = Σcredit > 0. El `role` es
 * `line_<n>` (1-based, orden de entrada) — único por línea, como exige
 * `validateLines`.
 */
export function buildJournalEntryLines(
  lines: JournalEntryLineInput[]
): LedgerLine[] {
  if (
    lines.length < JOURNAL_ENTRY_MIN_LINES ||
    lines.length > JOURNAL_ENTRY_MAX_LINES
  )
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "line_count",
      lineCount: lines.length,
    });

  let debit = 0n;
  let credit = 0n;
  const out: LedgerLine[] = lines.map((line, index) => {
    const oneSided =
      line.debit_cents > 0n !== line.credit_cents > 0n &&
      line.debit_cents >= 0n &&
      line.credit_cents >= 0n;
    if (!oneSided)
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "line_must_have_exactly_one_side",
        index,
      });
    if (line.account.account_type === "NonPosting")
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "non_posting_account",
        index,
        account_list_id: line.account.id,
      });
    debit += line.debit_cents;
    credit += line.credit_cents;
    return {
      role: `line_${index + 1}`,
      account: line.account,
      debit_cents: line.debit_cents,
      credit_cents: line.credit_cents,
      memo: line.memo ?? undefined,
    };
  });

  if (debit !== credit || debit <= 0n)
    throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
      debit: debit.toString(),
      credit: credit.toString(),
    });
  return out;
}
