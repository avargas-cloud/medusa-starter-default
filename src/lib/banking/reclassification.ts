import type { PoolClient } from "pg";
import { z } from "zod";

import { getBusinessDateString } from "../date/et";
import {
  createJournalEntry,
  getJournalEntry,
  postJournalEntry,
  type JournalEntryDto,
  type JournalEntryLineInput,
} from "../ledger/documents/journal-entry";
import { loadActiveAccounts } from "../ledger/documents/manual-shared";
import { LedgerError, type LedgerAccount } from "../ledger/types";
import { payeeColumnSql, PAYEE_JOIN_SQL, glCheckJoinSql } from "../ledger/reports/doc-labels";

/**
 * "Corregir" en una fila Reconciled del Bank Feed, regla 3 de
 * docs/POLITICA_CORRECCIONES_CONTABLES.md: extracto CERRADO, mismo monto, cuenta
 * contable equivocada → un Journal Entry de RECLASIFICACIÓN en el mes abierto
 * (Dr cuenta correcta / Cr cuenta equivocada). El banco no cambia, así que el
 * extracto cerrado no se toca y `bank_statement_assert_open` no interviene.
 *
 * Lo que este módulo NO hace, a propósito: un extracto en borrador se DESCASA
 * (`statements/:id/unmatch`), no se reclasifica; un error de vendor, bill o
 * impuesto va por Void + rehacer (pieza pendiente). El JE queda ENLAZADO al
 * match (`corrects_*`), y esa suma es el techo de lo reclasificable por línea.
 */
const BANK_TYPES = new Set(["Bank", "CreditCard"]);
const FIRST_OPEN_YEAR_DAY = "2026-01-01";

export const reclassifySchema = z.object({
  match_id: z.string().min(1),
  counter_line_id: z.string().min(1),
  to_account_list_id: z.string().min(1),
  amount_cents: z.number().int().positive(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(500).optional(),
});
export type ReclassifyInput = z.infer<typeof reclassifySchema>;

export interface ReclassifyContext {
  match_id: string;
  statement_status: "draft" | "closed";
  entry_id: string;
  entry_reference: string;
  payee_name: string | null;
  /** The counter line named by the caller — null when it is not a line of THIS entry. */
  counter: {
    line_id: string;
    account_list_id: string;
    account_name: string;
    account_type: string;
    debit_cents: number;
    credit_cents: number;
    reclassified_cents: number;
  } | null;
}

/** $1 = match_id · $2 = counter_line_id. */
export const RECLASSIFY_CONTEXT_SQL = `SELECT m.id AS match_id,st.status AS statement_status,e.id AS entry_id,e.reference AS entry_reference,
    ${payeeColumnSql("payee_name")} AS payee_name,
    c.id AS counter_line_id,c.account_list_id AS counter_account_list_id,
    COALESCE(c.account_snapshot->>'name','') AS counter_account_name,COALESCE(c.account_snapshot->>'account_type','') AS counter_account_type,
    c.debit_cents::float8 AS counter_debit_cents,c.credit_cents::float8 AS counter_credit_cents,
    COALESCE((SELECT SUM(jl.debit_cents) FROM gl_journal_entry j JOIN gl_journal_entry_line jl ON jl.journal_entry_id=j.id
      WHERE j.corrects_line_id=c.id AND j.status='posted' AND j.deleted_at IS NULL),0)::float8 AS counter_reclassified_cents
  FROM bank_statement_match m
  JOIN bank_statement_line sl ON sl.id=m.statement_line_id AND sl.deleted_at IS NULL
  JOIN bank_statement st ON st.id=sl.statement_id AND st.deleted_at IS NULL
  JOIN bank_journal_line l ON l.id=m.book_id AND l.deleted_at IS NULL
  JOIN bank_journal_entry e ON e.id=l.entry_id AND e.deleted_at IS NULL
  ${PAYEE_JOIN_SQL}${glCheckJoinSql("payee_name")}
  LEFT JOIN bank_journal_line c ON c.id=$2 AND c.entry_id=e.id AND c.deleted_at IS NULL
  WHERE m.id=$1 AND m.deleted_at IS NULL AND m.book_kind='journal_line'`;

type ContextRow = {
  match_id: string;
  statement_status: "draft" | "closed";
  entry_id: string;
  entry_reference: string;
  payee_name: string | null;
  counter_line_id: string | null;
  counter_account_list_id: string | null;
  counter_account_name: string;
  counter_account_type: string;
  counter_debit_cents: number | null;
  counter_credit_cents: number | null;
  counter_reclassified_cents: number;
};

export async function loadReclassifyContext(
  client: Pick<PoolClient, "query">,
  matchId: string,
  counterLineId: string
): Promise<ReclassifyContext | null> {
  const row = (await client.query<ContextRow>(RECLASSIFY_CONTEXT_SQL, [matchId, counterLineId])).rows[0];
  if (!row) return null;
  return {
    match_id: row.match_id,
    statement_status: row.statement_status,
    entry_id: row.entry_id,
    entry_reference: row.entry_reference,
    payee_name: row.payee_name,
    counter:
      row.counter_line_id && row.counter_account_list_id
        ? {
            line_id: row.counter_line_id,
            account_list_id: row.counter_account_list_id,
            account_name: row.counter_account_name,
            account_type: row.counter_account_type,
            debit_cents: Number(row.counter_debit_cents),
            credit_cents: Number(row.counter_credit_cents),
            reclassified_cents: Number(row.counter_reclassified_cents),
          }
        : null,
  };
}

function invalid(reason: string, extra: Record<string, unknown> = {}): never {
  throw new LedgerError("GL_SOURCE_INVALID", { reason, ...extra });
}

/**
 * Pure: decides the JE (day, memo, two lines) or throws `GL_SOURCE_INVALID`
 * with a named reason. Never touches a Bank/CreditCard account.
 */
export function planReclassification(
  context: ReclassifyContext,
  input: ReclassifyInput,
  target: LedgerAccount
): { day: string; memo: string; lines: JournalEntryLineInput[] } {
  if (context.statement_status !== "closed") invalid("statement_not_closed");
  const counter = context.counter;
  if (!counter) invalid("counter_line_not_in_entry");
  if (BANK_TYPES.has(counter.account_type)) invalid("counter_line_is_bank");
  if (BANK_TYPES.has(target.account_type)) invalid("target_account_is_bank");
  if (target.id === counter.account_list_id) invalid("same_account");
  const day = input.day ?? getBusinessDateString(new Date());
  if (day < FIRST_OPEN_YEAR_DAY) invalid("day_before_2026", { day });
  const reclassifiable = Math.abs(counter.debit_cents - counter.credit_cents) - counter.reclassified_cents;
  if (input.amount_cents <= 0 || input.amount_cents > reclassifiable)
    invalid("amount_exceeds_reclassifiable", { reclassifiable_cents: reclassifiable });
  const memo =
    input.memo?.trim() ||
    `Reclassification · ${context.entry_reference}${context.payee_name ? ` · ${context.payee_name}` : ""}`;
  const amount = BigInt(input.amount_cents);
  const debitSide = counter.debit_cents > 0; // the wrong account was DEBITED → move the debit
  const to = { account_list_id: target.id, debit_cents: debitSide ? amount : 0n, credit_cents: debitSide ? 0n : amount, memo };
  const from = { account_list_id: counter.account_list_id, debit_cents: debitSide ? 0n : amount, credit_cents: debitSide ? amount : 0n, memo };
  return { day, memo, lines: debitSide ? [to, from] : [from, to] };
}

/**
 * Orchestration: context → plan → draft JE → link (`corrects_*`) → post (GL +
 * QB lane). If the post is refused (Month Close), the draft is deleted so no
 * half-correction lingers; a rejected plan writes nothing at all.
 */
export async function reclassifyMatch(
  client: PoolClient,
  input: ReclassifyInput,
  actorId: string
): Promise<{ journal_entry: JournalEntryDto; entry_id: string }> {
  const context = await loadReclassifyContext(client, input.match_id, input.counter_line_id);
  if (!context) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { match_id: input.match_id });
  const target = (await loadActiveAccounts(client, [input.to_account_list_id])).get(input.to_account_list_id)!;
  const plan = planReclassification(context, input, target);
  const draft = await createJournalEntry(client, { day: plan.day, memo: plan.memo, lines: plan.lines }, actorId);
  await client.query(
    `UPDATE gl_journal_entry SET corrects_entry_id=$2,corrects_line_id=$3,corrects_match_id=$4,correction_type='reclassification',updated_at=now() WHERE id=$1`,
    [draft.id, context.entry_id, context.counter!.line_id, context.match_id]
  );
  try {
    const posted = await postJournalEntry(client, draft.id, actorId);
    if (posted.status === "already_posted" || !posted.entry_id)
      throw new LedgerError("GL_SOURCE_INVALID", { reason: "post_did_not_create_entry" });
    return { journal_entry: (await getJournalEntry(client, draft.id))!, entry_id: posted.entry_id };
  } catch (error) {
    // A draft that could not post is not a correction: remove it (no GL entry exists yet).
    await client.query(`DELETE FROM gl_journal_entry_line WHERE journal_entry_id=$1`, [draft.id]);
    await client.query(`DELETE FROM gl_journal_entry WHERE id=$1 AND status='draft'`, [draft.id]);
    throw error;
  }
}
