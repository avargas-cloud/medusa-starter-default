/**
 * qb-gl-import — ensamblador PURO: filas del reporte → documentos por TxnID.
 *
 * Medido el 2026-09-11: las líneas de Inventory Asset / COGS que QuickBooks
 * deriva de los ítems de una venta (Sales Receipt, Invoice, Credit Memo, Item
 * Receipt) vienen SIN `TxnID`. Traen tipo, fecha, número y nombre, así que se
 * unen al documento que ya tiene TxnID con esa misma clave. Si la clave no
 * existe (huérfana) o matchea más de un documento (ambigua), el documento no
 * se adivina: se bloquea con su motivo.
 *
 * Reglas del motor que se afirman acá, antes de tocar la DB
 * (`lib/ledger/post.ts#validateLines`): 2..200 líneas, cada línea débito XOR
 * crédito > 0, Σdébitos = Σcréditos. Las filas en cero (documentos voideados
 * siguen en el reporte con $0,00) se descartan; un documento cuyas filas eran
 * todas cero se salta sin bloquear.
 */
import type { AssembleResult, BlockedDocument, QbGlDocument, QbGlRow } from "./types";

export const MAX_LINES_PER_DOCUMENT = 200;

function docKey(row: Pick<QbGlRow, "txn_type" | "date" | "ref_number" | "name">): string {
  return [row.txn_type, row.date, row.ref_number ?? "", row.name ?? ""].join("|");
}

function isZero(row: QbGlRow): boolean {
  return row.debit_cents === 0n && row.credit_cents === 0n;
}

/** Tope de búsqueda: k^n asignaciones (3^12 = 531.441). Más que eso se bloquea. */
const MAX_AMBIGUOUS_ROWS = 12;
const MAX_AMBIGUOUS_CANDIDATES = 3;

function net(rows: QbGlRow[]): bigint {
  let n = 0n;
  for (const r of rows) n += r.debit_cents - r.credit_cents;
  return n;
}

/**
 * Reparte `pending` entre `candidates` de modo que cada documento quede
 * balanceado, y devuelve la PRIMERA partición que lo logra (o `null` si no
 * existe ninguna).
 *
 * Por qué la primera y no "la única": medido el 2026-01-26 (Goodlite,
 * SH041268 ×2), las filas sin TxnID de un Item Receipt son pares que se
 * cancelan entre sí (Inventory Asset crédito 136,01 / Purchases débito 136,01
 * — el ajuste de costo que QB deriva al recibir), así que CUALQUIER reparto
 * deja balanceados a los dos documentos y el efecto por cuenta es idéntico
 * en todos: lo único que cambia es a qué recibo del mismo proveedor y día se
 * le cuelga cada par. Exigir unicidad bloqueaba 15 recibos en 6 semanas sin
 * ganar nada contable. Lo que sigue bloqueando es no encontrar reparto.
 */
export function splitByBalance(pending: QbGlRow[], candidates: QbGlDocument[]): QbGlRow[][] | null {
  const k = candidates.length;
  if (k < 2 || k > MAX_AMBIGUOUS_CANDIDATES || pending.length === 0 || pending.length > MAX_AMBIGUOUS_ROWS)
    return null;
  const need = candidates.map((c) => -net(c.rows)); // lo que cada doc necesita recibir para balancear
  const assign = new Array<number>(pending.length).fill(0);
  let found: number[] | null = null;
  const walk = (i: number, running: bigint[]): void => {
    if (found) return;
    if (i === pending.length) {
      if (running.every((v, j) => v === need[j])) found = [...assign];
      return;
    }
    const row = pending[i] as QbGlRow;
    const delta = row.debit_cents - row.credit_cents;
    for (let j = 0; j < k && !found; j++) {
      assign[i] = j;
      running[j] = (running[j] ?? 0n) + delta;
      walk(i + 1, running);
      running[j] = (running[j] ?? 0n) - delta;
    }
  };
  walk(0, candidates.map(() => 0n));
  const chosen: number[] | null = found;
  if (!chosen) return null;
  return candidates.map((_, j) => pending.filter((_, idx) => chosen[idx] === j));
}

export function assembleDocuments(rows: QbGlRow[]): AssembleResult {
  const byTxnId = new Map<string, QbGlDocument>();
  const txnIdsByKey = new Map<string, Set<string>>();
  const blocked: BlockedDocument[] = [];

  // 1) Documentos identificados por TxnID, en orden de aparición.
  for (const row of rows) {
    if (!row.txn_id) continue;
    let doc = byTxnId.get(row.txn_id);
    if (!doc) {
      doc = {
        txn_id: row.txn_id,
        txn_type: row.txn_type,
        date: row.date,
        ref_number: row.ref_number,
        name: row.name,
        rows: [],
      };
      byTxnId.set(row.txn_id, doc);
    }
    doc.rows.push(row);
    const key = docKey(row);
    const set = txnIdsByKey.get(key) ?? new Set<string>();
    set.add(row.txn_id);
    txnIdsByKey.set(key, set);
  }

  // 2) Filas sin TxnID: se unen por (tipo, fecha, número, nombre). Con UN
  //    candidato se adjuntan; con varios (dos Item Receipts del mismo
  //    proveedor el mismo día, sin número — medido 12 casos en 5 semanas) se
  //    reparten por BALANCE: la única partición que deja a cada documento con
  //    Σdébitos = Σcréditos. Si no hay ninguna o hay más de una distinta, se bloquea.
  const orphans = new Map<string, { sample: QbGlRow; count: number; reason: BlockedDocument["reason"] }>();
  const poisoned = new Set<string>();
  const pendingByKey = new Map<string, QbGlRow[]>();
  for (const row of rows) {
    if (row.txn_id) continue;
    const key = docKey(row);
    const candidates = txnIdsByKey.get(key);
    if (!candidates || candidates.size === 0) {
      const o = orphans.get(key) ?? { sample: row, count: 0, reason: "orphan_rows_without_txn_id" as const };
      o.count += 1;
      orphans.set(key, o);
      continue;
    }
    if (candidates.size > 1) {
      const list = pendingByKey.get(key) ?? [];
      list.push(row);
      pendingByKey.set(key, list);
      continue;
    }
    for (const txnId of candidates) byTxnId.get(txnId)?.rows.push(row); // exactamente un candidato
  }
  for (const [key, pending] of pendingByKey) {
    const candidates = [...(txnIdsByKey.get(key) ?? [])]
      .map((id) => byTxnId.get(id))
      .filter((d): d is QbGlDocument => d !== undefined);
    const split = splitByBalance(pending, candidates);
    if (split) {
      split.forEach((rowsForDoc, i) => candidates[i]?.rows.push(...rowsForDoc));
      continue;
    }
    orphans.set(key, { sample: pending[0] as QbGlRow, count: pending.length, reason: "ambiguous_rows_without_txn_id" });
    for (const doc of candidates) poisoned.add(doc.txn_id);
  }
  for (const [key, o] of orphans) {
    blocked.push({
      key,
      txn_type: o.sample.txn_type,
      date: o.sample.date,
      reason: o.reason,
      detail: o.reason === "ambiguous_rows_without_txn_id"
        ? `${o.count} fila(s) matchean ${txnIdsByKey.get(key)?.size ?? 0} documentos`
        : `${o.count} fila(s) sin documento con TxnID`,
      rows: o.count,
    });
  }

  // 3) Limpieza de ceros y validación local de cada documento.
  const documents: QbGlDocument[] = [];
  let droppedZero = 0;
  let skippedZeroDocs = 0;
  for (const doc of byTxnId.values()) {
    if (poisoned.has(doc.txn_id)) {
      blocked.push({
        key: doc.txn_id,
        txn_type: doc.txn_type,
        date: doc.date,
        reason: "ambiguous_rows_without_txn_id",
        detail: "comparte clave con otro documento y hay filas sin TxnID que no se pueden asignar",
        rows: doc.rows.length,
      });
      continue;
    }
    const live = doc.rows.filter((r) => !isZero(r));
    droppedZero += doc.rows.length - live.length;
    if (live.length === 0) {
      skippedZeroDocs += 1;
      continue;
    }
    if (live.length < 2 || live.length > MAX_LINES_PER_DOCUMENT) {
      blocked.push({
        key: doc.txn_id,
        txn_type: doc.txn_type,
        date: doc.date,
        reason: "line_count_out_of_range",
        detail: `${live.length} línea(s) con importe`,
        rows: live.length,
      });
      continue;
    }
    let debit = 0n;
    let credit = 0n;
    for (const r of live) {
      debit += r.debit_cents;
      credit += r.credit_cents;
    }
    if (debit !== credit) {
      blocked.push({
        key: doc.txn_id,
        txn_type: doc.txn_type,
        date: doc.date,
        reason: "unbalanced",
        detail: `debit=${debit} credit=${credit}`,
        rows: live.length,
      });
      continue;
    }
    documents.push({ ...doc, rows: live });
  }

  documents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txn_id < b.txn_id ? -1 : 1));
  return { documents, blocked, dropped_zero_rows: droppedZero, skipped_zero_documents: skippedZeroDocs };
}
