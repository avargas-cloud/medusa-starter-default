import type { PoolClient } from "pg";
import { z } from "zod";

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "../../purchase-orders/qb-purchase-dependency-chain";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { isQbSyncEnabled } from "../../quickbooks/sync-enabled";
import { buildTxnVoidQbxml, type VoidableTxnType } from "../../quickbooks/txn-void-add";
import { activeDocumentEntry, reverseDocumentJournal, runInPostingTransaction } from "../post";
import { LedgerError } from "../types";
import { QB_IMPORT_SOURCE_KIND } from "./post";

/**
 * Void de un documento importado de QuickBooks (`qb_import:<TxnID>`) desde la
 * UI (plan qb-import-void-ui-20260915) — la pieza que habilita "Void + rehacer"
 * de docs/POLITICA_CORRECCIONES_CONTABLES.md (reglas 1 y 4).
 *
 * Dos mitades, en UNA transacción: la reversa contable (`reverseDocumentJournal`,
 * el mismo motor que `scripts/ledger/void-imported-document.ts`) y una fila
 * `qb_import_void` en el pipeline que despacha el `TxnVoidRq` por el bridge.
 *
 * Reglas que codifica:
 * - La reversa se fecha el MISMO día del original. Así muerde
 *   `bank_statement_assert_open`: un doc dentro de un extracto CERRADO exige
 *   reabrirlo primero (`statement_closed`). El `--day` libre queda en el script.
 * - La ruta no toca extractos: un asiento con match vivo se rechaza
 *   (`entry_matched`) — descasar es una decisión del contador por su ruta.
 * - Sólo tipos bancarios con `TxnVoidType`: Transfer no tiene TxnVoid en QBXML
 *   y los tipos de AR/AP (Bill, Invoice, Payment…) tienen espejo en otra pantalla.
 * - `qb_import_void` NO entra en `GL_POSTED_PIPELINE_STEPS` del importador a
 *   propósito: si el TxnVoid falla, QB sigue teniendo el doc y el próximo import
 *   lo vuelve a traer — el libro espeja a QB en vez de esconder el drift.
 */
export const QB_IMPORT_VOID_STEP = "qb_import_void" as const;

/** `txn_type` tal como lo imprime el reporte General Ledger → `TxnVoidType` de QBXML. */
export const QB_IMPORT_VOIDABLE_TYPES: Readonly<Record<string, VoidableTxnType>> = {
  Check: "Check",
  Deposit: "Deposit",
  "Credit Card Charge": "CreditCardCharge",
  "Credit Card Credit": "CreditCardCredit",
  "General Journal": "JournalEntry",
};

export const qbImportVoidSchema = z
  .object({
    txn_id: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type QbImportVoidInput = z.infer<typeof qbImportVoidSchema>;

export interface QbImportVoidContext {
  txn_id: string;
  entry_id: string;
  day: string;
  txn_type: string;
  reference: string;
  amount_cents: number;
  reversed: boolean;
  /** Live statement match on any line of the entry (draft or closed) — null when free. */
  live_match: { match_id: string; statement_id: string; statement_status: "draft" | "closed" } | null;
}

/** $1 = TxnID. Latest imported entry for that document, its reversal state and any live match. */
export const QB_IMPORT_VOID_CONTEXT_SQL = `SELECT e.id AS entry_id,e.day::text AS day,e.source_id AS txn_id,
    COALESCE(e.source_snapshot->>'txn_type','') AS txn_type,e.reference,e.amount_cents::float8 AS amount_cents,
    EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id AND r.deleted_at IS NULL) AS reversed,
    m.id AS match_id,m.statement_id,st.status AS statement_status
  FROM bank_journal_entry e
  LEFT JOIN LATERAL (
    SELECT m.id,m.statement_id FROM bank_statement_match m JOIN bank_journal_line l ON l.id=m.book_id
     WHERE l.entry_id=e.id AND m.book_kind='journal_line' AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1
  ) m ON true
  LEFT JOIN bank_statement st ON st.id=m.statement_id
  WHERE e.source_kind=$1 AND e.source_id=$2 AND e.kind='document' AND e.deleted_at IS NULL
  ORDER BY e.created_at DESC LIMIT 1`;

type ContextRow = {
  entry_id: string;
  day: string;
  txn_id: string;
  txn_type: string;
  reference: string;
  amount_cents: number;
  reversed: boolean;
  match_id: string | null;
  statement_id: string | null;
  statement_status: "draft" | "closed" | null;
};

export async function loadQbImportVoidContext(
  client: Pick<PoolClient, "query">,
  txnId: string
): Promise<QbImportVoidContext | null> {
  const row = (await client.query<ContextRow>(QB_IMPORT_VOID_CONTEXT_SQL, [QB_IMPORT_SOURCE_KIND, txnId])).rows[0];
  if (!row) return null;
  return {
    txn_id: row.txn_id,
    entry_id: row.entry_id,
    day: row.day,
    txn_type: row.txn_type,
    reference: row.reference,
    amount_cents: Number(row.amount_cents),
    reversed: row.reversed,
    live_match:
      row.match_id && row.statement_id && row.statement_status
        ? { match_id: row.match_id, statement_id: row.statement_id, statement_status: row.statement_status }
        : null,
  };
}

function invalid(reason: string, extra: Record<string, unknown> = {}): never {
  throw new LedgerError("GL_SOURCE_INVALID", { reason, ...extra });
}

/**
 * Pure: decides the reversal (day = the original's) and the QuickBooks void
 * type, or throws `GL_SOURCE_INVALID` with a named reason. Never touches the DB.
 */
export function planQbImportVoid(
  context: QbImportVoidContext | null,
  txnId: string
): { entry_id: string; day: string; qb_txn_type: VoidableTxnType } {
  if (!context) invalid("not_imported", { txn_id: txnId });
  if (context.reversed) invalid("already_reversed", { entry_id: context.entry_id });
  const qbTxnType = QB_IMPORT_VOIDABLE_TYPES[context.txn_type];
  if (!qbTxnType) invalid("type_not_voidable", { txn_type: context.txn_type });
  if (context.live_match)
    invalid("entry_matched", {
      match_id: context.live_match.match_id,
      statement_id: context.live_match.statement_id,
      statement_status: context.live_match.statement_status,
    });
  return { entry_id: context.entry_id, day: context.day, qb_txn_type: qbTxnType };
}

export interface QbImportVoidResult {
  txn_id: string;
  entry_id: string;
  reversal_entry_id: string;
  day: string;
  qb: { queued: true; pipeline_row_id: string; status: string } | { queued: false; reason: string };
}

/** Payload of a `qb_import_void` pipeline row. */
export interface QbImportVoidPayload {
  txn_id: string;
  qb_txn_type: VoidableTxnType;
  qbxml: string;
  reason: string;
}

async function enqueueQbImportVoid(
  client: PoolClient,
  txnId: string,
  qbTxnType: VoidableTxnType,
  reason: string
): Promise<QbImportVoidResult["qb"]> {
  if (!isQbSyncEnabled()) return { queued: false, reason: "QB_SYNC_ENABLED=false" };
  const payload: QbImportVoidPayload = { txn_id: txnId, qb_txn_type: qbTxnType, qbxml: buildTxnVoidQbxml(qbTxnType, txnId), reason };
  const row = payload as unknown as Record<string, unknown>;
  const operation = await enqueuePurchaseQbOperation(clientInTransactionAsKnex(client), {
    purchaseOrderId: txnId,
    referenceId: txnId,
    referenceType: QB_IMPORT_SOURCE_KIND,
    step: QB_IMPORT_VOID_STEP,
    payload: row,
    qbTxnId: txnId,
    operationKey: purchaseOperationKey(QB_IMPORT_VOID_STEP, txnId, row),
  });
  if (!operation) return { queued: false, reason: "QB_SYNC_ENABLED=false" };
  return { queued: true, pipeline_row_id: operation.id, status: operation.status };
}

/**
 * Orchestration: context → plan → reversal dated on the original day → pipeline
 * row. The statement trigger (`bank_statement_journal_guard`) rejects a Bank or
 * CreditCard reversal line dated inside a CLOSED statement: that surfaces as
 * `statement_closed` and nothing is written (the posting transaction rolls back).
 */
export async function voidQbImportDocument(
  client: PoolClient,
  input: QbImportVoidInput,
  actorId: string
): Promise<QbImportVoidResult> {
  return runInPostingTransaction(client, async () => {
    const plan = planQbImportVoid(await loadQbImportVoidContext(client, input.txn_id), input.txn_id);
    let reversal: Awaited<ReturnType<typeof reverseDocumentJournal>>;
    try {
      reversal = await reverseDocumentJournal(client, {
        source_kind: QB_IMPORT_SOURCE_KIND,
        source_id: input.txn_id,
        day: plan.day,
        reason: input.reason,
        actor_id: actorId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("BANKING_STATEMENT_PERIOD_CLOSED")) invalid("statement_closed", { day: plan.day });
      throw error;
    }
    if (reversal.status !== "reversed") invalid("reversal_not_created", { status: reversal.status });
    // Belt and braces: the reversal must have left no active entry behind.
    if (await activeDocumentEntry(client, QB_IMPORT_SOURCE_KIND, input.txn_id))
      invalid("reversal_not_created", { status: "still_active" });
    const qb = await enqueueQbImportVoid(client, input.txn_id, plan.qb_txn_type, input.reason);
    return { txn_id: input.txn_id, entry_id: plan.entry_id, reversal_entry_id: reversal.entry_id, day: plan.day, qb };
  });
}
