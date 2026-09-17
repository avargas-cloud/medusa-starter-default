/**
 * adopt-qb-bank-documents — escritura: adopción (una transacción para todo el
 * lote + renumeración) y su vuelta exacta (`--revert`).
 *
 * Por documento adoptado, en este orden y dentro de la MISMA transacción:
 *   1. INSERT del header nativo (`gl_check` + `gl_check_line`, o `gl_transfer`)
 *      ya `posted`, con `entry_id` = el asiento importado, `qb_txn_id` = TxnID,
 *      `qb_txn_type` = tipo QB, `qb_edit_sequence` del bridge si lo hubo,
 *      `qb_source = 'adopted'` y un `doc_number` temporal (`tmp:<id>`).
 *   2. RE-PARENT del asiento: `source_kind` qb_import → bank_check|bank_transfer,
 *      `source_id` → id del documento (arista `adopt` del guard: exige que el
 *      documento ya apunte al asiento y lleve ese TxnID). Líneas, matches,
 *      `source_hash`, `source_snapshot`, `reference` y `description` no se tocan
 *      (los dos últimos entran en el `input_hash` de los extractos cerrados).
 *   3. Fila `gl_document_add` en `qb_order_pipeline` creada y marcada `confirmed`
 *      con `qb_result.adopted = true` en la misma transacción — el despachador
 *      (cron de cada minuto) nunca la ve `pending`, así que jamás sale un ADD a QuickBooks.
 * Al final, `applyRenumber` asigna la serie cronológica definitiva y re-etiqueta
 * los asientos (arista `renumber`).
 *
 * Nunca: `enqueueGlDocumentAdd` (armaría un QBXML listo para despachar),
 * `postBankCheck`/`postBankTransfer` (postearían un asiento nuevo), ni
 * `reverseDocumentJournal` sobre el qb_import (los extractos cerrados rechazan
 * líneas nuevas y el libro quedaría con un agujero).
 */
import type { PoolClient } from "pg";

import { GL_DOCUMENT_ADD_STEP } from "../../quickbooks/gl-documents/types";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { enqueuePurchaseQbOperation, purchaseOperationKey } from "../../purchase-orders/qb-purchase-dependency-chain";
import { newGlId, toAccountSnapshot } from "../documents/manual-shared";
import type { QbImportSnapshot } from "../qb-import/types";

import type { AdoptionDecision, ImportedAccount, ImportedBankEntry } from "./classify-imported";
import type { ResolvedPayee } from "./payee";
import { applyRenumber, relabelJournal, type RenumberPlan } from "./renumber";
import { SALES_SQL, WRITE } from "../../quickbooks/pipeline-status";

export interface AdoptionPlanItem {
  entry: ImportedBankEntry;
  decision: AdoptionDecision;
  payee: ResolvedPayee | null;
}

export interface ApplyResult {
  adopted: { gl_check: number; gl_transfer: number };
  renumbered: number;
  totalCents: bigint;
  renumberMap: Array<{ table: "gl_check" | "gl_transfer"; id: string; from: string; to: string }>;
}

/** El tipo QB tal como lo nombra `TxnVoidRq` (`TxnVoidType`). */
const QB_TXN_TYPE: Record<string, string> = {
  Check: "Check",
  "Credit Card Charge": "CreditCardCharge",
  "Credit Card Credit": "CreditCardCredit",
  Transfer: "Transfer",
};

const snap = (a: ImportedAccount) => JSON.stringify(toAccountSnapshot({ ...a, currency: "USD", normal_balance: null }));

/** El memo del importador es el memo de la primera fila, o la etiqueta "Tipo Nº" cuando no había. */
function docMemo(entry: ImportedBankEntry, payee: ResolvedPayee | null): string | null {
  const label = `${entry.txn_type} ${entry.ref_number ?? entry.txn_id}`;
  const fromEntry = entry.memo && entry.memo !== label ? entry.memo : null;
  return payee?.qb_memo?.trim() || fromEntry || null;
}

async function insertCheck(client: PoolClient, item: AdoptionPlanItem, actorId: string): Promise<string> {
  const d = item.decision;
  if (d.target !== "gl_check") throw new Error("insertCheck: decisión equivocada");
  const payee = item.payee ?? { payee_type: "other" as const, payee_id: null, payee_name: item.entry.name ?? `QB ${item.entry.txn_type}`, edit_sequence: null, to_be_printed: false, qb_memo: null, qb_lines: [], resolved_by: "none" as const };
  const id = newGlId("gchk");
  await client.query(
    `INSERT INTO gl_check (id, number, doc_number, kind, day, bank_account_list_id, bank_account_snapshot, payee_type, payee_id, payee_name,
       memo, total_cents, status, entry_id, posted_at, to_be_printed, created_by, qb_txn_id, qb_txn_type, qb_edit_sequence, qb_synced_at, qb_source)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7::jsonb,$8,$9,$10,$11,$12,'posted',$13,now(),$14,$15,$16,$17,$18,now(),'adopted')`,
    [id, d.number, `tmp:${id}`, d.kind, item.entry.day, d.bank_account.id, snap(d.bank_account), payee.payee_type, payee.payee_id, payee.payee_name,
      docMemo(item.entry, payee), d.total_cents, item.entry.entry_id, payee.to_be_printed, actorId, item.entry.txn_id,
      // ATAJO: `qb_txn_type` guarda "CreditCardCredit"/"Transfer" aunque `GlQbTxnType` no los enumere — el void de un
      // CreditCardCredit lo acepta QB; el de un Transfer (5 docs) falla con motivo en el pipeline. Disparador: el primer
      // void de un documento adoptado de esos dos tipos.
      QB_TXN_TYPE[item.entry.txn_type] ?? item.entry.txn_type, payee.edit_sequence]
  );
  const qbLines = payee.qb_lines.length === d.lines.length ? payee.qb_lines : [];
  for (const [index, line] of d.lines.entries()) {
    const extra = qbLines[index];
    await client.query(
      `INSERT INTO gl_check_line (id, check_id, sort_order, account_list_id, account_snapshot, amount_cents, memo, customer_id, billable)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [newGlId("gchkl"), id, index + 1, line.account.id, snap(line.account), line.amount_cents, extra?.memo ?? line.memo, extra?.customer_id ?? null, extra?.billable ?? false]
    );
  }
  return id;
}

async function insertTransfer(client: PoolClient, item: AdoptionPlanItem, actorId: string): Promise<string> {
  const d = item.decision;
  if (d.target !== "gl_transfer") throw new Error("insertTransfer: decisión equivocada");
  const id = newGlId("gtr");
  const base = docMemo(item.entry, item.payee);
  const memo = d.net ? `${base ? `${base} · ` : ""}QB ${item.entry.txn_type} ${item.entry.ref_number ?? item.entry.txn_id} · ${d.line_count} líneas (neto)` : base;
  await client.query(
    `INSERT INTO gl_transfer (id, doc_number, day, from_account_list_id, from_snapshot, to_account_list_id, to_snapshot, amount_cents, fee_cents,
       fee_account_list_id, fee_account_snapshot, memo, status, entry_id, posted_at, created_by, qb_txn_id, qb_txn_type, qb_edit_sequence, qb_synced_at, qb_source)
     VALUES ($1,$2,$3::date,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,'posted',$13,now(),$14,$15,$16,$17,now(),'adopted')`,
    [id, `tmp:${id}`, item.entry.day, d.from.id, snap(d.from), d.to.id, snap(d.to), d.amount_cents, d.fee_account ? d.fee_cents : null,
      d.fee_account?.id ?? null, d.fee_account ? snap(d.fee_account) : null, memo, item.entry.entry_id, actorId, item.entry.txn_id,
      QB_TXN_TYPE[item.entry.txn_type] ?? item.entry.txn_type, item.payee?.edit_sequence ?? null]
  );
  return id;
}

async function reparent(client: PoolClient, item: AdoptionPlanItem, table: "gl_check" | "gl_transfer", id: string): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE bank_journal_entry SET source_kind = $3, source_id = $4, document_number = $5, updated_at = now()
      WHERE id = $1 AND source_kind = 'qb_import' AND source_id = $2 AND kind = 'document'`,
    [item.entry.entry_id, item.entry.txn_id, table === "gl_check" ? "bank_check" : "bank_transfer", id, `tmp:${id}`]
  );
  if (rowCount !== 1) throw new Error(`re-parent falló para ${item.entry.txn_id}: ${rowCount} filas`);
}

async function adoptedPipelineRow(client: PoolClient, table: "gl_check" | "gl_transfer", id: string, txnId: string, txnType: string): Promise<void> {
  const knex = clientInTransactionAsKnex(client);
  const payload = { kind: table, document_id: id, qb_txn_type: QB_TXN_TYPE[txnType] ?? txnType, qbxml: null, ready: false, reason: `adopted from QuickBooks (${txnId}); no ADD`, adopted: true };
  const op = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: id, referenceId: id, referenceType: table, step: GL_DOCUMENT_ADD_STEP,
    payload, qbTxnId: txnId, operationKey: purchaseOperationKey(GL_DOCUMENT_ADD_STEP, id, payload),
  });
  if (!op) throw new Error("QB_SYNC_ENABLED=false: no se puede registrar la fila adoptada del pipeline");
  await client.query(
    `UPDATE qb_order_pipeline SET status='${WRITE.sales.synced}', qb_txn_id=$2, confirmed_at=now(), error=NULL, qb_result=$3::jsonb, updated_at=now()
      WHERE id=$1::uuid AND status IN (${SALES_SQL.dispatchable}, ${SALES_SQL.blocked})`,
    [op.id, txnId, JSON.stringify({ adopted: true, qb_txn_id: txnId, note: "documento creado en QuickBooks; el POS adopta el TxnID, no manda ADD" })]
  );
}

export async function applyAdoption(client: PoolClient, input: { plan: AdoptionPlanItem[]; renumber: RenumberPlan; actorId: string }): Promise<ApplyResult> {
  const created = new Map<string, string>();
  const result: ApplyResult = { adopted: { gl_check: 0, gl_transfer: 0 }, renumbered: 0, totalCents: 0n, renumberMap: [] };
  await client.query("BEGIN");
  try {
    for (const [index, item] of input.plan.entries()) {
      const d = item.decision;
      if (d.target === "unmapped") continue;
      const id = d.target === "gl_check" ? await insertCheck(client, item, input.actorId) : await insertTransfer(client, item, input.actorId);
      await reparent(client, item, d.target, id);
      await adoptedPipelineRow(client, d.target, id, item.entry.txn_id, item.entry.txn_type);
      created.set(`plan:${index}`, id);
      result.adopted[d.target] += 1;
      result.totalCents += d.target === "gl_check" ? d.total_cents : d.amount_cents;
    }
    const r = await applyRenumber(client, input.renumber, (key) => created.get(key) ?? key);
    result.renumbered = r.renumbered;
    result.renumberMap = r.map;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  return result;
}

/** Textos del asiento de un `qb_import`, con la misma forma que `qb-import/post.ts::toPostInput`. */
export function qbImportTexts(s: QbImportSnapshot): { document_number: string; reference: string; description: string } {
  const truncate = (v: string | null, max: number) => (!v ? "" : v.length > max ? `${v.slice(0, max - 1)}…` : v);
  const label = `${s.txn_type} ${s.ref_number ?? s.txn_id}`;
  return {
    document_number: truncate(label, 80),
    reference: truncate(`QB ${label}${s.name ? ` · ${s.name}` : ""}`, 200),
    description: truncate(s.rows[0]?.memo ?? label, 500),
  };
}

/**
 * Un adoptado que el POS ya ANULÓ (status `voided`, con su reversa y su TxnVoid encolado) no
 * se revierte: es una operación del negocio posterior a la adopción, no parte de ella.
 */
export async function revertAdoption(
  client: PoolClient,
  input: { from: string; to: string; renumber: Array<{ table: "gl_check" | "gl_transfer"; id: string; from: string; to: string }>; actorId: string }
): Promise<{ reverted: number; renumbered: number; skipped: number }> {
  const out = { reverted: 0, renumbered: 0, skipped: 0 };
  await client.query("BEGIN");
  try {
    for (const table of ["gl_check", "gl_transfer"] as const) {
      const { rows } = await client.query<{ id: string; entry_id: string; qb_txn_id: string; snapshot: QbImportSnapshot }>(
        `SELECT d.id, d.entry_id, d.qb_txn_id, e.source_snapshot AS snapshot FROM ${table} d JOIN bank_journal_entry e ON e.id = d.entry_id
          WHERE d.qb_source = 'adopted' AND d.deleted_at IS NULL AND d.status = 'posted' AND d.day >= $1::date AND d.day <= $2::date`,
        [input.from, input.to]
      );
      for (const doc of rows) {
        // El número queda libre para quien lo tenía antes (UNIQUE no es parcial); el documento borrado conserva el TxnID.
        await client.query(`UPDATE ${table} SET deleted_at = now(), doc_number = 'rev:' || id, updated_at = now() WHERE id = $1`, [doc.id]);
        // reference/description nunca cambiaron (inmutables); document_number vuelve al del importador
        const texts = qbImportTexts(doc.snapshot);
        const { rowCount } = await client.query(
          `UPDATE bank_journal_entry SET source_kind = 'qb_import', source_id = $2, document_number = $3, updated_at = now()
            WHERE id = $1 AND source_id = $4 AND kind = 'document'`,
          [doc.entry_id, doc.qb_txn_id, texts.document_number, doc.id]
        );
        if (rowCount !== 1) throw new Error(`revert falló para ${doc.id}`);
        await client.query(
          `UPDATE qb_order_pipeline SET status = '${WRITE.sales.skipped}', error = 'adopción revertida', updated_at = now()
            WHERE step = $1 AND reference_type = $2 AND reference_id = $3 AND status IN (${SALES_SQL.synced})`,
          [GL_DOCUMENT_ADD_STEP, table, doc.id]
        );
        out.reverted += 1;
      }
    }
    // números anteriores de los nativos (los adoptados ya no están vivos)
    const live = input.renumber.filter((m) => m.from && m.from !== m.to);
    if (live.length) {
      for (const table of ["gl_check", "gl_transfer"] as const) {
        const ids = live.filter((m) => m.table === table).map((m) => m.id);
        if (ids.length) await client.query(`UPDATE ${table} SET doc_number = 'tmp:' || id WHERE id = ANY($1::text[]) AND deleted_at IS NULL`, [ids]);
      }
      for (const m of live) {
        const { rowCount } = await client.query(`UPDATE ${m.table} SET doc_number = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [m.id, m.from]);
        if (rowCount === 1) {
          await relabelJournal(client, m.table, m.id);
          out.renumbered += 1;
        } else out.skipped += 1;
      }
      for (const table of ["gl_check", "gl_transfer"] as const) {
        await client.query(
          `UPDATE document_number_counter SET value = (SELECT COALESCE(max(substring(doc_number from '\\d+$')::int), 0) FROM ${table} WHERE deleted_at IS NULL AND doc_number !~ '^tmp:'), updated_at = now() WHERE name = $1`,
          [table]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  return out;
}
