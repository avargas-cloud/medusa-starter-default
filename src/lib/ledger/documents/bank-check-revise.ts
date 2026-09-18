import type { PoolClient } from "pg";

import { reviewHash } from "../../banking/review-common";
import { bankId } from "../../banking/store";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { enqueueGlDocumentMod } from "../../quickbooks/gl-documents/enqueue";
import type { GlDocumentEnqueueResult } from "../../quickbooks/gl-documents/enqueue";
import { reverseDocumentJournal, runInPostingTransaction } from "../post";
import { LedgerError } from "../types";

import { postCheckJournal, resolve, writeHeaderAndLines } from "./bank-check";
import {
  getBankCheck,
  loadHeader,
  type BankCheckDto,
  type BankCheckWriteInput,
  type HeaderRow,
} from "./bank-check-read";

/**
 * check-revise-20260918 — corrección EN EL LUGAR de un `gl_check` posteado.
 *
 * Un cheque mal cargado (cuenta, monto, fecha, payee…) se corrige sin anularlo:
 * mismo documento, mismo CHK-####, mismo TxnID en QuickBooks. En UNA transacción:
 *
 *   1. reversa del asiento activo, fechada en el DÍA ORIGINAL del cheque (como
 *      `redate-gl-document.ts` y el void de `qb_import`): el mes queda neto. Si
 *      ese día cae en un extracto cerrado el trigger `bank_statement_journal_guard`
 *      lo rechaza → `statement_closed`; un mes cerrado → `GL_PERIOD_CLOSED`.
 *      Fail-closed: un período cerrado se corrige con un JE de reclasificación,
 *      nunca reescribiendo lo que el contador ya cerró.
 *   2. header + líneas reescritos con el input nuevo (`kind`/`total` re-derivados).
 *   3. asiento nuevo en el día nuevo (`postCheckJournal`), `entry_id` apuntando a él.
 *   4. los matches VIVOS del extracto borrador que consumían la línea bancaria
 *      vieja se llevan a la nueva (soft-delete + insert, que es lo único que el
 *      trigger `bank_statement_match_capacity` admite) — sólo si banco, monto y
 *      día siguen dentro del mismo extracto; si no → `entry_matched`, descasar
 *      primero (botón Corregir del Bank Feed).
 *   5. `CheckMod`/`CreditCardChargeMod` encolado (`gl_document_mod`).
 *
 * Prohibido cambiar el TIPO de cuenta pagadora (Bank ↔ CreditCard): QuickBooks
 * no convierte un Check en un CreditCardCharge → `revise_type_change`, y el
 * camino es void + documento nuevo.
 */

export interface ReviseBankCheckResult {
  check: BankCheckDto;
  reversal_entry_id: string;
  entry_id: string;
  qb: GlDocumentEnqueueResult;
}

interface BankLine {
  id: string;
  entry_id: string;
  account_list_id: string;
  amount_cents: number;
  source_hash: string;
}

interface LiveMatch {
  id: string;
  statement_id: string;
  statement_line_id: string;
  amount_cents: number;
  line_hash: string;
  statement_status: string;
  statement_account_list_id: string;
  statement_to_day: string;
}

function invalid(reason: string, extra: Record<string, unknown> = {}): never {
  throw new LedgerError("GL_SOURCE_INVALID", { reason, ...extra });
}

/** Líneas de la cuenta pagadora (Bank/CreditCard) del asiento — un cheque tiene exactamente una. */
async function bankLinesOf(client: PoolClient, entryId: string): Promise<BankLine[]> {
  const { rows } = await client.query<BankLine>(
    `SELECT l.id, l.entry_id, l.account_list_id, (l.debit_cents - l.credit_cents)::float8 AS amount_cents, e.source_hash
       FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE l.entry_id = $1 AND l.account_snapshot->>'account_type' IN ('Bank','CreditCard')
      ORDER BY l.id`,
    [entryId]
  );
  return rows;
}

async function liveMatchesOf(client: PoolClient, bankLineIds: string[]): Promise<LiveMatch[]> {
  if (bankLineIds.length === 0) return [];
  const { rows } = await client.query<LiveMatch>(
    `SELECT m.id, m.statement_id, m.statement_line_id, m.amount_cents::float8 AS amount_cents, m.line_hash,
            s.status AS statement_status, s.account_list_id AS statement_account_list_id, s.to_day::text AS statement_to_day
       FROM bank_statement_match m JOIN bank_statement s ON s.id = m.statement_id
      WHERE m.book_kind = 'journal_line' AND m.book_id = ANY($1::text[]) AND m.deleted_at IS NULL
      ORDER BY m.created_at`,
    [bankLineIds]
  );
  return rows;
}

/**
 * Pure: decide si los matches vivos se pueden llevar a la línea nueva. Sólo
 * borradores, y sólo si la línea nueva es la misma "cosa" para el banco
 * (misma cuenta, mismo monto con signo, día dentro del extracto).
 */
export function planMatchCarryOver(
  matches: LiveMatch[],
  oldLine: BankLine | null,
  newLine: BankLine | null,
  newDay: string
): { carry: LiveMatch[] } {
  if (matches.length === 0) return { carry: [] };
  if (!oldLine || !newLine) invalid("entry_matched", { match_ids: matches.map((m) => m.id) });
  for (const m of matches) {
    const same =
      m.statement_status === "draft" &&
      m.statement_account_list_id === newLine.account_list_id &&
      oldLine.account_list_id === newLine.account_list_id &&
      oldLine.amount_cents === newLine.amount_cents &&
      newDay <= m.statement_to_day;
    if (!same)
      invalid("entry_matched", {
        match_id: m.id,
        statement_id: m.statement_id,
        statement_status: m.statement_status,
      });
  }
  return { carry: matches };
}

async function carryOverMatches(
  client: PoolClient,
  carry: LiveMatch[],
  newLine: BankLine,
  actorId: string,
  reason: string
): Promise<void> {
  if (carry.length === 0) return;
  // Mismo hash que `statementBook` arma para un documento GL (blockers = []).
  const bookHash = reviewHash({
    id: newLine.id,
    amount: newLine.amount_cents,
    source_hash: newLine.source_hash,
    blockers: [],
  });
  for (const m of carry) {
    await client.query(
      `UPDATE bank_statement_match SET deleted_at = now(), updated_at = now(), removed_by = $2, removed_reason = $3
        WHERE id = $1 AND deleted_at IS NULL`,
      [m.id, actorId, `revised: ${reason}`.slice(0, 500)]
    );
    await client.query(
      `INSERT INTO bank_statement_match(id, statement_id, statement_line_id, book_kind, book_id, amount_cents, book_hash, line_hash, actor_id)
       VALUES ($1, $2, $3, 'journal_line', $4, $5, $6, $7, $8)`,
      [
        bankId("bsm"),
        m.statement_id,
        m.statement_line_id,
        newLine.id,
        m.amount_cents,
        bookHash,
        m.line_hash,
        actorId,
      ]
    );
  }
  const statements = [...new Set(carry.map((m) => m.statement_id))];
  await client.query(
    `UPDATE bank_statement SET revision = revision + 1, updated_at = now() WHERE id = ANY($1::text[])`,
    [statements]
  );
}

export async function reviseBankCheck(
  client: PoolClient,
  id: string,
  input: BankCheckWriteInput,
  reason: string,
  actorId: string
): Promise<ReviseBankCheckResult> {
  return runInPostingTransaction(client, async () => {
    const header = await loadHeader(client, id, true);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (header.status !== "posted" || !header.entry_id)
      throw new LedgerError("GL_DOCUMENT_NOT_POSTED", { id, status: header.status });

    // El input nuevo se resuelve ANTES de tocar nada: cuentas inactivas, other
    // name apagado o líneas inválidas rechazan sin dejar una reversa huérfana.
    const next = await resolve(client, input);
    const oldType = header.bank_account_snapshot.account_type;
    if (oldType !== next.bankAccount.account_type)
      invalid("revise_type_change", { from: oldType, to: next.bankAccount.account_type });

    const oldBankLines = await bankLinesOf(client, header.entry_id);
    const matches = await liveMatchesOf(
      client,
      oldBankLines.map((l) => l.id)
    );

    let reversal: Awaited<ReturnType<typeof reverseDocumentJournal>>;
    try {
      reversal = await reverseDocumentJournal(client, {
        source_kind: "bank_check",
        source_id: id,
        day: header.day,
        reason,
        actor_id: actorId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("BANKING_STATEMENT_PERIOD_CLOSED")) invalid("statement_closed", { day: header.day });
      throw error;
    }
    if (reversal.status !== "reversed") invalid("reversal_not_created", { status: reversal.status });

    await writeHeaderAndLines(client, id, input, { insert: false });
    const rewritten = (await loadHeader(client, id, true)) as HeaderRow;
    const posted = await postCheckJournal(client, rewritten, actorId);
    if (posted.status !== "posted") invalid("repost_not_created", { status: posted.status });

    const newBankLines = await bankLinesOf(client, posted.entry_id);
    const { carry } = planMatchCarryOver(matches, oldBankLines[0] ?? null, newBankLines[0] ?? null, input.day);
    if (carry.length) await carryOverMatches(client, carry, newBankLines[0]!, actorId, reason);

    await client.query(
      `UPDATE gl_check
          SET status = 'posted', entry_id = $2, revision = revision + 1, revised_at = now(), revised_by = $3,
              revision_reason = $4, updated_at = now()
        WHERE id = $1`,
      [id, posted.entry_id, actorId, reason]
    );
    const qb = await enqueueGlDocumentMod(clientInTransactionAsKnex(client), "gl_check", id);
    return {
      check: (await getBankCheck(client, id))!,
      reversal_entry_id: reversal.entry_id,
      entry_id: posted.entry_id,
      qb,
    };
  });
}
