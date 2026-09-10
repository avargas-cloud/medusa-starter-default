import type { PoolClient } from "pg";

import {
  acquireBankAccountingPeriodLock,
  assertBankAccountingPeriodOpen,
} from "../accounting/banking-period-lock";
import { bankId } from "../banking/store";

import { LedgerError, PostDocumentInput, PostResult, ReverseResult } from "./types";

/** Postgres error code that `gl_document_source_unique` raises for a duplicate active document. */
const PG_ALREADY_POSTED_MESSAGE = "GL_ALREADY_POSTED";
const PG_UNBALANCED_MESSAGE = "GL_UNBALANCED_DOCUMENT";
const PG_SOURCE_INVALID_MESSAGE = "GL_SOURCE_INVALID";

function rethrowAsLedgerError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(PG_ALREADY_POSTED_MESSAGE))
    throw new LedgerError("GL_ALREADY_POSTED");
  if (message.includes(PG_UNBALANCED_MESSAGE))
    throw new LedgerError("GL_UNBALANCED_DOCUMENT");
  if (message.includes(PG_SOURCE_INVALID_MESSAGE))
    throw new LedgerError("GL_SOURCE_INVALID");
  throw err;
}

/**
 * §5: "transacción propia si el caller no la abrió". `SAVEPOINT gl_post`
 * sólo es válido DENTRO de un bloque de transacción — si `client` está en
 * autocommit (sin `BEGIN` abierto), Postgres lo rechaza con SQLSTATE 25P01
 * ("no existe una transacción SQL activa"), y ahí el motor abre y es dueño
 * de su propia transacción. Si el SAVEPOINT se acepta, el caller ya tenía
 * una transacción abierta y el motor sólo participa de ella (release/rollback
 * al savepoint, nunca COMMIT/ROLLBACK ajeno). Sin esto, el disparador
 * DEFERRED de balance corre statement-por-statement en autocommit y rechaza
 * todo posting real con un `GL_UNBALANCED_DOCUMENT` falso (las líneas
 * todavía no existen cuando el INSERT del header ya "cerró" su transacción).
 */
const POSTING_SAVEPOINT = "gl_post";
const NO_ACTIVE_TRANSACTION_SQLSTATE = "25P01";

export async function runInPostingTransaction<T>(
  client: PoolClient,
  work: () => Promise<T>
): Promise<T> {
  let ownsTransaction: boolean;
  try {
    await client.query(`SAVEPOINT ${POSTING_SAVEPOINT}`);
    ownsTransaction = false;
  } catch (err) {
    if ((err as { code?: string }).code !== NO_ACTIVE_TRANSACTION_SQLSTATE) throw err;
    await client.query("BEGIN");
    ownsTransaction = true;
  }

  try {
    const result = await work();
    await client.query(
      ownsTransaction ? "COMMIT" : `RELEASE SAVEPOINT ${POSTING_SAVEPOINT}`
    );
    return result;
  } catch (err) {
    await client.query(
      ownsTransaction ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${POSTING_SAVEPOINT}`
    );
    throw err;
  }
}

function validateLines(input: PostDocumentInput): bigint {
  if (input.lines.length < 2 || input.lines.length > 200)
    throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
      lineCount: input.lines.length,
    });
  let debit = 0n;
  let credit = 0n;
  const roles = new Set<string>();
  for (const line of input.lines) {
    if (roles.has(line.role))
      throw new LedgerError("GL_SOURCE_INVALID", { duplicateRole: line.role });
    roles.add(line.role);
    if (
      (line.debit_cents > 0n) === (line.credit_cents > 0n) ||
      line.debit_cents < 0n ||
      line.credit_cents < 0n
    )
      throw new LedgerError("GL_UNBALANCED_DOCUMENT", { role: line.role });
    debit += line.debit_cents;
    credit += line.credit_cents;
  }
  if (debit !== credit || debit <= 0n)
    throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
      debit: debit.toString(),
      credit: credit.toString(),
    });
  return debit;
}

/**
 * §5/§1 — postea un documento en la familia `document` del journal de
 * Banking. Best-effort en el CALLER (los hooks atrapan el try/catch, ver
 * §6): acá el fallo siempre es una excepción, nunca un valor silencioso.
 * Idempotente: una segunda llamada para el mismo (source_kind, source_id)
 * activo devuelve `already_posted` sin volver a escribir nada.
 */
export async function postDocumentJournal(
  client: PoolClient,
  input: PostDocumentInput
): Promise<PostResult> {
  const existing = await activeDocumentEntry(client, input.source_kind, input.source_id);
  if (existing) return { status: "already_posted", entry_id: existing.id };

  const amount = validateLines(input);
  const id = bankId("bje");

  await runInPostingTransaction(client, async () => {
    await acquireBankAccountingPeriodLock(client, input.day);
    await assertBankAccountingPeriodOpenOrThrow(client, input.day);
    try {
      await client.query(
        `INSERT INTO bank_journal_entry
           (id, kind, source_kind, source_id, document_number, day, currency, amount_cents,
            source_hash, source_snapshot, reference, description, actor_id, posted_by)
         VALUES ($1,'document',$2,$3,$4,$5,'USD',$6,$7,$8::jsonb,$9,$10,$11,$11)`,
        [
          id,
          input.source_kind,
          input.source_id,
          input.document_number,
          input.day,
          amount,
          input.source_hash,
          JSON.stringify(input.source_snapshot),
          input.reference,
          input.description,
          input.actor_id,
        ]
      );
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO bank_journal_line(id, entry_id, role, account_list_id, account_snapshot, debit_cents, credit_cents)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [
            bankId("bjl"),
            id,
            line.role,
            line.account.id,
            JSON.stringify(line.account),
            line.debit_cents,
            line.credit_cents,
          ]
        );
      }
      for (const claim of input.claims ?? []) {
        await client.query(
          `INSERT INTO bank_source_claim(id, entry_id, source_kind, source_id, amount_cents, capacity_cents, source_hash, source_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            bankId("bsc"),
            id,
            claim.source_kind,
            claim.source_id,
            claim.amount_cents,
            claim.capacity_cents,
            claim.source_hash,
            JSON.stringify({ source: { source_kind: input.source_kind, source_id: input.source_id } }),
          ]
        );
      }
    } catch (err) {
      rethrowAsLedgerError(err);
    }
  });

  return { status: "posted", entry_id: id };
}

/**
 * Reversa exacta del asiento activo del documento. `nothing_to_reverse` si
 * nunca se posteó; `already_reversed` si la reversa ya existe — reversar es
 * idempotente igual que postear.
 */
export async function reverseDocumentJournal(
  client: PoolClient,
  input: {
    source_kind: PostDocumentInput["source_kind"];
    source_id: string;
    day: string;
    reason: string;
    actor_id: string;
  }
): Promise<ReverseResult> {
  const { rows } = await client.query<{
    id: string;
    amount_cents: string;
    source_hash: string;
    source_snapshot: unknown;
    reference: string;
    description: string;
    document_number: string | null;
    reversed_by: string | null;
  }>(
    `SELECT e.id, e.amount_cents::text, e.source_hash, e.source_snapshot, e.reference, e.description, e.document_number,
            (SELECT r.id FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id) AS reversed_by
     FROM bank_journal_entry e
     WHERE e.source_kind = $1 AND e.source_id = $2 AND e.kind = 'document'
     ORDER BY e.created_at DESC LIMIT 1`,
    [input.source_kind, input.source_id]
  );
  const original = rows[0];
  if (!original) return { status: "nothing_to_reverse" };
  if (original.reversed_by)
    return { status: "already_reversed", entry_id: original.reversed_by };

  const id = bankId("bje");

  await runInPostingTransaction(client, async () => {
    await acquireBankAccountingPeriodLock(client, input.day);
    await assertBankAccountingPeriodOpenOrThrow(client, input.day);

    const { rows: lineRows } = await client.query<{
      role: string;
      account_list_id: string;
      account_snapshot: unknown;
      debit_cents: string;
      credit_cents: string;
    }>(
      `SELECT role, account_list_id, account_snapshot, debit_cents::text, credit_cents::text
       FROM bank_journal_line WHERE entry_id = $1`,
      [original.id]
    );

    try {
      await client.query(
        `INSERT INTO bank_journal_entry
           (id, kind, source_kind, source_id, document_number, day, currency, amount_cents,
            source_hash, source_snapshot, reference, description, actor_id, reverses_entry_id, reason, posted_by)
         VALUES ($1,'reversal',$2,$3,$4,$5,'USD',$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$11)`,
        [
          id,
          input.source_kind,
          input.source_id,
          original.document_number,
          input.day,
          original.amount_cents,
          original.source_hash,
          JSON.stringify(original.source_snapshot),
          original.reference,
          original.description,
          input.actor_id,
          original.id,
          input.reason,
        ]
      );
      for (const line of lineRows) {
        await client.query(
          `INSERT INTO bank_journal_line(id, entry_id, role, account_list_id, account_snapshot, debit_cents, credit_cents)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [
            bankId("bjl"),
            id,
            line.role,
            line.account_list_id,
            JSON.stringify(line.account_snapshot),
            line.credit_cents,
            line.debit_cents,
          ]
        );
      }
    } catch (err) {
      rethrowAsLedgerError(err);
    }
  });

  return { status: "reversed", entry_id: id };
}

/** Entrada `document` activa (sin reversa) para un `(source_kind, source_id)`. */
export async function activeDocumentEntry(
  client: PoolClient,
  source_kind: PostDocumentInput["source_kind"],
  source_id: string
): Promise<{ id: string; day: string; amount_cents: string } | null> {
  const { rows } = await client.query<{
    id: string;
    day: string;
    amount_cents: string;
  }>(
    `SELECT e.id, e.day, e.amount_cents::text FROM bank_journal_entry e
     WHERE e.source_kind = $1 AND e.source_id = $2 AND e.kind = 'document'
       AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
     ORDER BY e.created_at DESC LIMIT 1`,
    [source_kind, source_id]
  );
  return rows[0] ?? null;
}

async function assertBankAccountingPeriodOpenOrThrow(
  client: PoolClient,
  day: string
): Promise<void> {
  try {
    await assertBankAccountingPeriodOpen(client, day);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("BANKING_ACCOUNTING_PERIOD_CLOSED"))
      throw new LedgerError("GL_PERIOD_CLOSED", { day });
    throw err;
  }
}
