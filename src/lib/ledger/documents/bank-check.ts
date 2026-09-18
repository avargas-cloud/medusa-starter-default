import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  bankCheckTotal,
  buildBankCheckLines,
  deriveBankCheckKind,
} from "../lines/bank-check";
import {
  postDocumentJournal,
  reverseDocumentJournal,
  runInPostingTransaction,
} from "../post";
import { LedgerError } from "../types";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { enqueueGlDocumentAdd, enqueueGlDocumentVoid } from "../../quickbooks/gl-documents/enqueue";

import {
  getBankCheck,
  loadHeader,
  loadLines,
  type BankCheckDto,
  type BankCheckWriteInput,
  type HeaderRow,
} from "./bank-check-read";
import type { PostGlDocumentResult } from "./journal-entry";
import {
  allocateGlNumber,
  assertStatus,
  loadActiveAccounts,
  loadActiveOtherNames,
  newGlId,
  reversalDay,
  toAccountSnapshot,
} from "./manual-shared";

/**
 * Lado de ESCRITURA de `gl_check`: create/update (sólo drafts; `kind` y
 * `total_cents` se re-derivan), post y void. Lectura en `bank-check-read.ts`.
 */
export {
  getBankCheck,
  listBankChecks,
  type BankCheckDto,
  type BankCheckLineDto,
  type BankCheckLineInput,
  type BankCheckWriteInput,
  type CheckPayeeType,
} from "./bank-check-read";

/**
 * Resuelve banco + cuentas de línea contra `qb_account` ACTIVAS, pasa por el
 * builder puro (que también valida) y deriva `kind`. Devuelve todo lo que el
 * header y las líneas necesitan persistir.
 */
export async function resolve(client: PoolClient, input: BankCheckWriteInput) {
  const accounts = await loadActiveAccounts(client, [
    input.bank_account_list_id,
    ...input.lines.map((l) => l.account_list_id),
  ]);
  const bankAccount = accounts.get(input.bank_account_list_id)!;
  const lines = input.lines.map((l) => ({
    ...l,
    account: accounts.get(l.account_list_id)!,
  }));
  const ledgerLines = buildBankCheckLines({ bankAccount, lines });
  // Payee `other_name`: el nombre es el de `qb_other_name` (snapshot), no el del cliente.
  const otherNames = await loadActiveOtherNames(client, [
    input.payee_type === "other_name" ? input.payee_id : null,
  ]);
  const payeeName =
    input.payee_type === "other_name" && input.payee_id
      ? otherNames.get(input.payee_id)!.name
      : input.payee_name;
  return {
    bankAccount,
    lines,
    ledgerLines,
    payeeName,
    kind: deriveBankCheckKind(bankAccount.account_type, input.number),
    total: bankCheckTotal(lines),
  };
}

export async function writeHeaderAndLines(
  client: PoolClient,
  id: string,
  input: BankCheckWriteInput,
  mode: { insert: true; docNumber: string; actorId: string } | { insert: false }
): Promise<void> {
  const r = await resolve(client, input);
  const number = input.number?.trim() ? input.number.trim() : null;
  const headerValues = [
    id,
    number,
    r.kind,
    input.day,
    input.bank_account_list_id,
    JSON.stringify(toAccountSnapshot(r.bankAccount)),
    input.payee_type,
    input.payee_id ?? null,
    r.payeeName,
    input.memo ?? null,
    r.total,
    input.to_be_printed ?? false,
    input.evidence_id ?? null,
  ];
  if (mode.insert) {
    await client.query(
      `INSERT INTO gl_check (id, number, kind, day, bank_account_list_id, bank_account_snapshot, payee_type, payee_id,
         payee_name, memo, total_cents, to_be_printed, evidence_id, doc_number, status, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15)`,
      [...headerValues, mode.docNumber, mode.actorId]
    );
  } else {
    await client.query(
      `UPDATE gl_check SET number=$2, kind=$3, day=$4::date, bank_account_list_id=$5, bank_account_snapshot=$6::jsonb,
         payee_type=$7, payee_id=$8, payee_name=$9, memo=$10, total_cents=$11, to_be_printed=$12, evidence_id=$13,
         updated_at=now() WHERE id=$1`,
      headerValues
    );
    await client.query(`DELETE FROM gl_check_line WHERE check_id = $1`, [id]);
  }
  for (const [index, line] of r.lines.entries()) {
    await client.query(
      `INSERT INTO gl_check_line (id, check_id, sort_order, account_list_id, account_snapshot, amount_cents, memo, customer_id, billable)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [
        newGlId("gchkl"),
        id,
        index + 1,
        line.account_list_id,
        JSON.stringify(toAccountSnapshot(line.account)),
        line.amount_cents,
        line.memo ?? null,
        line.customer_id ?? null,
        line.billable ?? false,
      ]
    );
  }
}

/**
 * Un caller puede colgar trabajo DENTRO de la transacción del documento
 * (`inTransaction`): el enlace con una ocurrencia del Accounting Calendar
 * vive ahí, así un check y su ocurrencia nacen o mueren juntos.
 */
export interface BankCheckHooks {
  inTransaction?: (client: PoolClient, id: string) => Promise<void>;
}

export async function createBankCheck(
  client: PoolClient,
  input: BankCheckWriteInput,
  actorId: string,
  hooks: BankCheckHooks = {}
): Promise<BankCheckDto> {
  const id = newGlId("gchk");
  await runInPostingTransaction(client, async () => {
    const docNumber = await allocateGlNumber(client, "gl_check", "CHK");
    await writeHeaderAndLines(client, id, input, {
      insert: true,
      docNumber,
      actorId,
    });
    if (hooks.inTransaction) await hooks.inTransaction(client, id);
  });
  return (await getBankCheck(client, id))!;
}

/** Sólo un `draft` se edita acá; un `posted` se corrige por `reviseBankCheck` (`bank-check-revise.ts`). */
export async function updateBankCheck(
  client: PoolClient,
  id: string,
  input: BankCheckWriteInput
): Promise<BankCheckDto> {
  await runInPostingTransaction(client, async () => {
    const header = await loadHeader(client, id, true);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    assertStatus(header.status, "draft", id);
    await writeHeaderAndLines(client, id, input, { insert: false });
  });
  return (await getBankCheck(client, id))!;
}

/**
 * Arma el asiento del cheque desde SU estado persistido (header + líneas) y lo
 * postea en `header.day`. Compartido por el post inicial y por el revise
 * (`bank-check-revise.ts`), que lo llama tras reescribir header y líneas.
 */
export async function postCheckJournal(
  client: PoolClient,
  header: HeaderRow,
  actorId: string
): Promise<PostGlDocumentResult> {
  const id = header.id;
  const lineRows = (await loadLines(client, [id])).get(id) ?? [];
  // Re-resolve against ACTIVE accounts: a draft may predate an account being retired.
  const { ledgerLines } = await resolve(client, {
    ...header,
    lines: lineRows.map((l) => ({
      ...l,
      amount_cents: BigInt(l.amount_cents),
    })),
  });
  const sourceSnapshot = { header, lines: lineRows };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");
  const label =
    header.kind === "card_charge"
      ? "Card Charge"
      : header.kind === "check"
        ? "Check"
        : "Expense";
  const result = await postDocumentJournal(client, {
    source_kind: "bank_check",
    source_id: id,
    document_number: header.doc_number,
    day: header.day,
    reference: header.number
      ? `${header.doc_number} #${header.number}`
      : header.doc_number,
    description: `${label} ${header.doc_number} — ${header.payee_name}`,
    lines: ledgerLines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
  if (result.status === "skipped")
    throw new LedgerError("GL_SOURCE_INVALID", { reason: result.reason });
  return { status: result.status, entry_id: result.entry_id };
}

/** `postDocumentJournal` + flip a `posted` en UNA transacción; `already_posted` si ya lo estaba. */
export async function postBankCheck(
  client: PoolClient,
  id: string,
  actorId: string
): Promise<PostGlDocumentResult> {
  return runInPostingTransaction(client, async () => {
    const header = await loadHeader(client, id, true);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (header.status === "posted" && header.entry_id)
      return { status: "already_posted", entry_id: header.entry_id };
    assertStatus(header.status, "draft", id);

    const result = await postCheckJournal(client, header, actorId);
    await client.query(
      `UPDATE gl_check SET status = 'posted', entry_id = $2, posted_at = now(), updated_at = now() WHERE id = $1`,
      [id, result.entry_id]
    );
    const qb = await enqueueGlDocumentAdd(clientInTransactionAsKnex(client), "gl_check", id);
    return { status: result.status, entry_id: result.entry_id, qb };
  });
}

/** Reversa el asiento (si lo hay) y deja el documento `voided` con motivo. */
export async function voidBankCheck(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string,
  hooks: BankCheckHooks = {}
): Promise<BankCheckDto> {
  await runInPostingTransaction(client, async () => {
    const header = await loadHeader(client, id, true);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (header.status === "voided")
      throw new LedgerError("GL_DOCUMENT_NOT_POSTED", {
        id,
        status: header.status,
      });
    if (header.status === "posted")
      await reverseDocumentJournal(client, {
        source_kind: "bank_check",
        source_id: id,
        day: reversalDay(header.day),
        reason,
        actor_id: actorId,
      });
    await client.query(
      `UPDATE gl_check SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason]
    );
    await enqueueGlDocumentVoid(clientInTransactionAsKnex(client), "gl_check", id);
    if (hooks.inTransaction) await hooks.inTransaction(client, id);
  });
  return (await getBankCheck(client, id))!;
}
