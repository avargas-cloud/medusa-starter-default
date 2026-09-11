/**
 * qb-gl-import — de `QbGlDocument` a `PostDocumentInput` y posteo por el motor.
 *
 * - `source_kind = 'qb_import'`, `source_id = TxnID`: el motor ya es
 *   idempotente por ese par (`postDocumentJournal` → `already_posted`), así
 *   que re-correr el import nunca duplica.
 * - Una línea del journal por fila del reporte, en el orden de QB, con rol
 *   `l001..l200` (el CHECK `bank_journal_role` exige `^[a-z][a-z0-9_]{0,79}$`
 *   y roles únicos por documento). Los roles `opening` y `uncleared_*` son
 *   de la apertura (Banking-on-GL) y no se usan acá.
 * - El snapshot guarda las filas crudas con su `ClearedStatus` de QB: es la
 *   pista para arrancar Banking desde el último extracto conciliado en QB.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { postDocumentJournal } from "../post";
import type { LedgerLine, PostDocumentInput, PostResult } from "../types";
import type { QbAccountIndex } from "./accounts";
import type { ImportPolicy, QbGlDocument, QbImportSnapshot } from "./types";

export const QB_IMPORT_SOURCE_KIND = "qb_import" as const;
export const QB_IMPORT_ACTOR = "qb-gl-import";

export class QbImportAccountError extends Error {
  constructor(readonly account: string) {
    super(`cuenta sin espejo en qb_account: ${account}`);
    this.name = "QbImportAccountError";
  }
}

function truncate(value: string | null, max: number): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Puro salvo por el índice de cuentas ya cargado. Lanza `QbImportAccountError` si falta una cuenta. */
export function toPostInput(
  doc: QbGlDocument,
  policy: ImportPolicy,
  accounts: QbAccountIndex
): PostDocumentInput {
  const lines: LedgerLine[] = [];
  const snapshotRows: QbImportSnapshot["rows"] = [];
  doc.rows.forEach((row, i) => {
    const account = accounts.get(row.account);
    if (!account) throw new QbImportAccountError(row.account);
    lines.push({
      role: `l${String(i + 1).padStart(3, "0")}`,
      account,
      debit_cents: row.debit_cents,
      credit_cents: row.credit_cents,
      memo: truncate(row.memo, 200) || undefined,
    });
    snapshotRows.push({
      account: row.account,
      account_list_id: account.id,
      memo: row.memo,
      split_account: row.split_account,
      cleared_status: row.cleared_status,
      debit_cents: row.debit_cents.toString(),
      credit_cents: row.credit_cents.toString(),
    });
  });
  const snapshot: QbImportSnapshot = {
    txn_id: doc.txn_id,
    txn_type: doc.txn_type,
    date: doc.date,
    ref_number: doc.ref_number,
    name: doc.name,
    policy,
    rows: snapshotRows,
  };
  const sourceHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const label = `${doc.txn_type} ${doc.ref_number ?? doc.txn_id}`;
  return {
    source_kind: QB_IMPORT_SOURCE_KIND,
    source_id: doc.txn_id,
    document_number: truncate(label, 80),
    day: doc.date,
    reference: truncate(`QB ${label}${doc.name ? ` · ${doc.name}` : ""}`, 200),
    description: truncate(doc.rows[0]?.memo ?? label, 500),
    lines,
    source_snapshot: snapshot as unknown as Record<string, unknown>,
    source_hash: sourceHash,
    actor_id: QB_IMPORT_ACTOR,
  };
}

export async function postQbDocument(
  client: PoolClient,
  doc: QbGlDocument,
  policy: ImportPolicy,
  accounts: QbAccountIndex
): Promise<PostResult> {
  return postDocumentJournal(client, toPostInput(doc, policy, accounts));
}
