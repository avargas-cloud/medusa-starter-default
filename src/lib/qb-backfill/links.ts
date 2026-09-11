/**
 * src/lib/qb-backfill/links.ts
 *
 * Resolución de enlaces entre documentos de compras del backfill (PO ↔
 * Receipt ↔ Bill) por TxnID/LinkedTxn de QB, y matching de líneas de un
 * documento hijo contra las líneas abiertas de su PO. Funciones PURAS (sin
 * IO) — los callers hacen las queries SQL y les pasan los datos ya
 * cargados, para poder testear la lógica de decisión sin Postgres.
 */
import type { QbLinkedTxn } from "./types";

/** TxnIDs de `linked_txns` de un tipo dado (p.ej. "PurchaseOrder", "Bill", "ItemReceipt"). */
export function linkedTxnIdsOfType(linked: readonly QbLinkedTxn[], txnType: string): string[] {
  return linked.filter((l) => l.txn_type === txnType).map((l) => l.txn_id);
}

export interface OpenPoLine {
  id: string;
  product_variant_id: string | null;
  qty_ordered: number;
  /** Ya asignado a OTRAS líneas de este mismo documento/run — no persistido, lo lleva el caller. */
  already_matched: number;
}

/**
 * Greedy: la primera línea del PO (en el orden dado — el caller ordena por
 * `line_order`/`id` ascendente) que comparte variante y tiene capacidad
 * abierta (`qty_ordered − already_matched > 0`). Cantidad parcial permitida:
 * no exige que la línea cubra el total pedido, sólo que tenga algo de
 * espacio — el caller decide si el remanente bloquea el documento.
 */
export function matchPoLineForVariant(
  lines: readonly OpenPoLine[],
  variantId: string | null,
  qtyNeeded: number
): OpenPoLine | null {
  if (!variantId || !(qtyNeeded > 0)) return null;
  for (const l of lines) {
    if (l.product_variant_id !== variantId) continue;
    if (l.qty_ordered - l.already_matched > 0) return l;
  }
  return null;
}
