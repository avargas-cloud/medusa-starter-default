import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { buildJournalEntryLines } from "../lines/journal-entry";
import {
  postDocumentJournal,
  reverseDocumentJournal,
  runInPostingTransaction,
} from "../post";
import { LedgerError } from "../types";

import {
  getJournalEntry,
  loadHeader,
  loadLines,
  type JournalEntryDto,
  type JournalEntryWriteInput,
} from "./journal-entry-read";
import {
  allocateGlNumber,
  assertStatus,
  loadActiveAccounts,
  newGlId,
  reversalDay,
  toAccountSnapshot,
} from "./manual-shared";

/**
 * Lado de ESCRITURA de `gl_journal_entry`: create/update (sólo drafts),
 * post (`postDocumentJournal` + flip en una transacción) y void
 * (`reverseDocumentJournal` + `voided`). Lectura en `journal-entry-read.ts`.
 */
export {
  getJournalEntry,
  listJournalEntries,
  type JournalEntryDto,
  type JournalEntryLineDto,
  type JournalEntryLineInput,
  type JournalEntryWriteInput,
} from "./journal-entry-read";

/** Valida contra cuentas ACTIVAS y el builder puro; devuelve las líneas listas para insertar. */
async function resolveLines(client: PoolClient, input: JournalEntryWriteInput) {
  const accounts = await loadActiveAccounts(
    client,
    input.lines.map((l) => l.account_list_id)
  );
  const resolved = input.lines.map((l) => ({
    ...l,
    account: accounts.get(l.account_list_id)!,
  }));
  const ledgerLines = buildJournalEntryLines(resolved);
  return { resolved, ledgerLines };
}

async function writeLines(
  client: PoolClient,
  id: string,
  input: JournalEntryWriteInput
): Promise<void> {
  const { resolved } = await resolveLines(client, input);
  await client.query(
    `DELETE FROM gl_journal_entry_line WHERE journal_entry_id = $1`,
    [id]
  );
  for (const [index, line] of resolved.entries()) {
    await client.query(
      `INSERT INTO gl_journal_entry_line
         (id, journal_entry_id, sort_order, account_list_id, account_snapshot, debit_cents, credit_cents, memo, entity_type, entity_id, entity_name)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
      [
        newGlId("gjel"),
        id,
        index + 1,
        line.account_list_id,
        JSON.stringify(toAccountSnapshot(line.account)),
        line.debit_cents,
        line.credit_cents,
        line.memo ?? null,
        line.entity_type ?? null,
        line.entity_id ?? null,
        line.entity_name ?? null,
      ]
    );
  }
}

export async function createJournalEntry(
  client: PoolClient,
  input: JournalEntryWriteInput,
  actorId: string
): Promise<JournalEntryDto> {
  const id = newGlId("gje");
  await runInPostingTransaction(client, async () => {
    const number = await allocateGlNumber(client, "gl_journal_entry", "JE");
    await client.query(
      `INSERT INTO gl_journal_entry (id, number, day, memo, status, evidence_id, created_by)
       VALUES ($1,$2,$3::date,$4,'draft',$5,$6)`,
      [
        id,
        number,
        input.day,
        input.memo ?? null,
        input.evidence_id ?? null,
        actorId,
      ]
    );
    await writeLines(client, id, input);
  });
  return (await getJournalEntry(client, id))!;
}

/** Sólo un `draft` se edita; un `posted` se anula y se crea de nuevo. */
export async function updateJournalEntry(
  client: PoolClient,
  id: string,
  input: JournalEntryWriteInput
): Promise<JournalEntryDto> {
  await runInPostingTransaction(client, async () => {
    const header = await loadHeader(client, id, true);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    assertStatus(header.status, "draft", id);
    await client.query(
      `UPDATE gl_journal_entry SET day = $2::date, memo = $3, evidence_id = $4, updated_at = now() WHERE id = $1`,
      [id, input.day, input.memo ?? null, input.evidence_id ?? null]
    );
    await writeLines(client, id, input);
  });
  return (await getJournalEntry(client, id))!;
}

export type PostGlDocumentResult = {
  status: "posted" | "already_posted";
  entry_id: string;
};

/**
 * Postea el draft: `postDocumentJournal` + flip a `posted` en UNA
 * transacción. Un documento ya `posted` contesta `already_posted` sin
 * escribir nada (idempotente, igual que el motor).
 */
export async function postJournalEntry(
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

    const lineRows = (await loadLines(client, [id])).get(id) ?? [];
    // Re-resolve against ACTIVE accounts: a draft may predate an account being retired.
    const accounts = await loadActiveAccounts(
      client,
      lineRows.map((l) => l.account_list_id)
    );
    const lines = buildJournalEntryLines(
      lineRows.map((l) => ({
        account: accounts.get(l.account_list_id)!,
        debit_cents: BigInt(l.debit_cents),
        credit_cents: BigInt(l.credit_cents),
        memo: l.memo,
      }))
    );
    const sourceSnapshot = { header, lines: lineRows };
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(sourceSnapshot))
      .digest("hex");
    const result = await postDocumentJournal(client, {
      source_kind: "journal_entry",
      source_id: id,
      document_number: header.number,
      day: header.day,
      reference: header.number,
      description: header.memo
        ? `Journal Entry ${header.number} — ${header.memo}`
        : `Journal Entry ${header.number}`,
      lines,
      source_snapshot: sourceSnapshot,
      source_hash: sourceHash,
      actor_id: actorId,
    });
    if (result.status === "skipped")
      throw new LedgerError("GL_SOURCE_INVALID", { reason: result.reason });
    await client.query(
      `UPDATE gl_journal_entry SET status = 'posted', entry_id = $2, posted_at = now(), updated_at = now() WHERE id = $1`,
      [id, result.entry_id]
    );
    return { status: result.status, entry_id: result.entry_id };
  });
}

/**
 * Anula: reversa el asiento (si lo hay) y deja el documento `voided` con su
 * motivo. Un `draft` se anula sin asiento; un `voided` ya está anulado
 * (`GL_DOCUMENT_NOT_POSTED`).
 */
export async function voidJournalEntry(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string
): Promise<JournalEntryDto> {
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
        source_kind: "journal_entry",
        source_id: id,
        day: reversalDay(header.day),
        reason,
        actor_id: actorId,
      });
    await client.query(
      `UPDATE gl_journal_entry SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason]
    );
  });
  return (await getJournalEntry(client, id))!;
}
