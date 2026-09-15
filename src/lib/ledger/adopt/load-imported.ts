/**
 * adopt-qb-bank-documents — carga los `qb_import` ACTIVOS (sin reversa) de los
 * tipos adoptables en una ventana de fechas, con sus líneas en el orden del
 * asiento y el memo por línea tomado del snapshot del importador
 * (`QbImportSnapshot.rows[i]` ↔ rol `l{i+1}`: `qb-import/post.ts` los escribe
 * en el mismo orden).
 *
 * Sólo lectura. Un TxnID que ya adoptó un documento (`gl_check.qb_txn_id` /
 * `gl_transfer.qb_txn_id`) se devuelve en `already` para que el script sea
 * idempotente sin volver a mirar el asiento.
 */
import type { PoolClient } from "pg";

import type { QbImportSnapshot } from "../qb-import/types";

import { ADOPTABLE_TXN_TYPES, type ImportedBankEntry, type ImportedLine } from "./classify-imported";

interface EntryRow {
  id: string;
  source_id: string;
  day: string;
  description: string;
  source_snapshot: QbImportSnapshot;
}

interface LineRow {
  id: string;
  entry_id: string;
  role: string;
  account_snapshot: { id: string; name: string; account_type: string };
  debit_cents: string;
  credit_cents: string;
}

export interface LoadedImports {
  entries: ImportedBankEntry[];
  /** TxnID → doc_number del documento nativo que ya lo adoptó. */
  already: Map<string, { table: "gl_check" | "gl_transfer"; id: string; doc_number: string }>;
}

export async function loadImportedBankEntries(
  client: PoolClient,
  window: { from: string; to: string }
): Promise<LoadedImports> {
  const { rows: entries } = await client.query<EntryRow>(
    `SELECT e.id, e.source_id, e.day, e.description, e.source_snapshot
       FROM bank_journal_entry e
      WHERE e.source_kind = 'qb_import' AND e.kind = 'document' AND e.deleted_at IS NULL
        AND e.day >= $1 AND e.day <= $2
        AND e.source_snapshot->>'txn_type' = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      ORDER BY e.day, e.created_at, e.id`,
    [window.from, window.to, [...ADOPTABLE_TXN_TYPES]]
  );
  const ids = entries.map((e) => e.id);
  const linesByEntry = new Map<string, ImportedLine[]>();
  if (ids.length) {
    const { rows: lines } = await client.query<LineRow>(
      `SELECT id, entry_id, role, account_snapshot, debit_cents::text, credit_cents::text
         FROM bank_journal_line WHERE entry_id = ANY($1::text[]) ORDER BY entry_id, role`,
      [ids]
    );
    const snapshotByEntry = new Map(entries.map((e) => [e.id, e.source_snapshot] as const));
    for (const line of lines) {
      const index = Number(line.role.replace(/^l/, "")) - 1;
      const snapshotRow = snapshotByEntry.get(line.entry_id)?.rows[index];
      const bucket = linesByEntry.get(line.entry_id) ?? [];
      bucket.push({
        line_id: line.id,
        account: line.account_snapshot,
        debit_cents: BigInt(line.debit_cents),
        credit_cents: BigInt(line.credit_cents),
        memo: snapshotRow?.memo ?? null,
      });
      linesByEntry.set(line.entry_id, bucket);
    }
  }
  const { rows: adopted } = await client.query<{ table: "gl_check" | "gl_transfer"; id: string; doc_number: string; qb_txn_id: string }>(
    `SELECT 'gl_check' AS "table", id, doc_number, qb_txn_id FROM gl_check WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
     UNION ALL
     SELECT 'gl_transfer', id, doc_number, qb_txn_id FROM gl_transfer WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL`
  );
  return {
    entries: entries.map((e) => ({
      entry_id: e.id,
      txn_id: e.source_id,
      txn_type: e.source_snapshot.txn_type,
      day: e.day,
      ref_number: e.source_snapshot.ref_number,
      name: e.source_snapshot.name,
      memo: e.description,
      lines: linesByEntry.get(e.id) ?? [],
    })),
    already: new Map(adopted.map((a) => [a.qb_txn_id, { table: a.table, id: a.id, doc_number: a.doc_number }])),
  };
}
