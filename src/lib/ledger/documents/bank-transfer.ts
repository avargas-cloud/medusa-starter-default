import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { buildBankTransferLines } from "../lines/bank-transfer";
import {
  postDocumentJournal,
  reverseDocumentJournal,
  runInPostingTransaction,
} from "../post";
import { LedgerError } from "../types";

import type { PostGlDocumentResult } from "./journal-entry";
import { listDocuments, type ListFilters, type ListPage } from "./manual-list";
import {
  AccountSnapshot,
  GlDocumentStatus,
  allocateGlNumber,
  assertStatus,
  loadActiveAccounts,
  newGlId,
  reversalDay,
  toAccountSnapshot,
} from "./manual-shared";

/** DDL: `src/migrations/1789300000000-GlManualDocuments.ts` (`gl_transfer`). */
export interface BankTransferWriteInput {
  day: string;
  from_account_list_id: string;
  to_account_list_id: string;
  amount_cents: bigint;
  memo?: string | null;
  evidence_id?: string | null;
}

export interface BankTransferDto {
  id: string;
  doc_number: string;
  day: string;
  from_account_list_id: string;
  from_snapshot: AccountSnapshot;
  to_account_list_id: string;
  to_snapshot: AccountSnapshot;
  amount_cents: number;
  memo: string | null;
  status: GlDocumentStatus;
  entry_id: string | null;
  posted_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  evidence_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Row = Omit<BankTransferDto, "amount_cents"> & { amount_cents: string };

const COLUMNS = `d.id, d.doc_number, d.day::text AS day, d.from_account_list_id, d.from_snapshot,
  d.to_account_list_id, d.to_snapshot, d.amount_cents::text AS amount_cents, d.memo, d.status, d.entry_id,
  d.posted_at::text AS posted_at, d.voided_at::text AS voided_at, d.void_reason, d.evidence_id,
  d.created_by, d.created_at::text AS created_at, d.updated_at::text AS updated_at`;

const toDto = (row: Row): BankTransferDto => ({
  ...row,
  amount_cents: Number(row.amount_cents),
});

async function loadRow(
  client: PoolClient,
  id: string,
  forUpdate = false
): Promise<Row | null> {
  const { rows } = await client.query<Row>(
    `SELECT ${COLUMNS} FROM gl_transfer d WHERE d.id = $1 AND d.deleted_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getBankTransfer(
  client: PoolClient,
  id: string
): Promise<BankTransferDto | null> {
  const row = await loadRow(client, id);
  return row ? toDto(row) : null;
}

export async function listBankTransfers(
  client: PoolClient,
  filters: ListFilters
): Promise<ListPage<BankTransferDto>> {
  const page = await listDocuments<Row>(
    client,
    {
      table: "gl_transfer",
      columns: COLUMNS,
      accountClause:
        "(d.from_account_list_id = {{p}} OR d.to_account_list_id = {{p}})",
      searchColumns: ["d.doc_number", "d.memo"],
    },
    filters
  );
  return { items: page.items.map(toDto), next_cursor: page.next_cursor };
}

async function resolve(client: PoolClient, input: BankTransferWriteInput) {
  const accounts = await loadActiveAccounts(client, [
    input.from_account_list_id,
    input.to_account_list_id,
  ]);
  const fromAccount = accounts.get(input.from_account_list_id)!;
  const toAccount = accounts.get(input.to_account_list_id)!;
  const ledgerLines = buildBankTransferLines({
    fromAccount,
    toAccount,
    amount_cents: input.amount_cents,
  });
  return { fromAccount, toAccount, ledgerLines };
}

export async function createBankTransfer(
  client: PoolClient,
  input: BankTransferWriteInput,
  actorId: string
): Promise<BankTransferDto> {
  const id = newGlId("gtr");
  await runInPostingTransaction(client, async () => {
    const r = await resolve(client, input);
    const docNumber = await allocateGlNumber(client, "gl_transfer", "TR");
    await client.query(
      `INSERT INTO gl_transfer (id, doc_number, day, from_account_list_id, from_snapshot, to_account_list_id, to_snapshot,
         amount_cents, memo, evidence_id, status, created_by)
       VALUES ($1,$2,$3::date,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,'draft',$11)`,
      [
        id,
        docNumber,
        input.day,
        input.from_account_list_id,
        JSON.stringify(toAccountSnapshot(r.fromAccount)),
        input.to_account_list_id,
        JSON.stringify(toAccountSnapshot(r.toAccount)),
        input.amount_cents,
        input.memo ?? null,
        input.evidence_id ?? null,
        actorId,
      ]
    );
  });
  return (await getBankTransfer(client, id))!;
}

/** `postDocumentJournal` + flip a `posted` en UNA transacción; `already_posted` si ya lo estaba. */
export async function postBankTransfer(
  client: PoolClient,
  id: string,
  actorId: string
): Promise<PostGlDocumentResult> {
  return runInPostingTransaction(client, async () => {
    const row = await loadRow(client, id, true);
    if (!row) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (row.status === "posted" && row.entry_id)
      return { status: "already_posted", entry_id: row.entry_id };
    assertStatus(row.status, "draft", id);

    // Re-resolve against ACTIVE accounts: a draft may predate an account being retired.
    const { ledgerLines } = await resolve(client, {
      ...row,
      amount_cents: BigInt(row.amount_cents),
    });
    const sourceSnapshot = { header: row };
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(sourceSnapshot))
      .digest("hex");
    const result = await postDocumentJournal(client, {
      source_kind: "bank_transfer",
      source_id: id,
      document_number: row.doc_number,
      day: row.day,
      reference: row.doc_number,
      description: `Transfer ${row.doc_number} — ${row.from_snapshot.name} → ${row.to_snapshot.name}`,
      lines: ledgerLines,
      source_snapshot: sourceSnapshot,
      source_hash: sourceHash,
      actor_id: actorId,
    });
    if (result.status === "skipped")
      throw new LedgerError("GL_SOURCE_INVALID", { reason: result.reason });
    await client.query(
      `UPDATE gl_transfer SET status = 'posted', entry_id = $2, posted_at = now(), updated_at = now() WHERE id = $1`,
      [id, result.entry_id]
    );
    return { status: result.status, entry_id: result.entry_id };
  });
}

/** Reversa el asiento (si lo hay) y deja el documento `voided` con motivo. */
export async function voidBankTransfer(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string
): Promise<BankTransferDto> {
  await runInPostingTransaction(client, async () => {
    const row = await loadRow(client, id, true);
    if (!row) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (row.status === "voided")
      throw new LedgerError("GL_DOCUMENT_NOT_POSTED", {
        id,
        status: row.status,
      });
    if (row.status === "posted")
      await reverseDocumentJournal(client, {
        source_kind: "bank_transfer",
        source_id: id,
        day: reversalDay(row.day),
        reason,
        actor_id: actorId,
      });
    await client.query(
      `UPDATE gl_transfer SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason]
    );
  });
  return (await getBankTransfer(client, id))!;
}
