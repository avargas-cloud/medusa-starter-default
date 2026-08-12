/**
 * Lee el InventoryAdjustment de defectuosos DESDE QuickBooks, justo antes de
 * despachar un Mod.
 *
 * Por qué contra QB y no contra nuestra base:
 *
 *  - El `EditSequence` es un compare-and-swap. Se mueve con CUALQUIER edición,
 *    incluida una hecha a mano en QuickBooks Desktop, y un valor cacheado da
 *    error 3200. Se pide en cada intento, nunca al encolar.
 *  - La identidad de las líneas (`TxnLineID`) sólo la sabe QuickBooks. Un Mod
 *    que no nombre una línea la BORRA, así que armar la lista de memoria es la
 *    forma exacta de perder una línea sin enterarse.
 *  - El estado actual permite saltear un Mod que no cambia nada, sin llamar al
 *    bridge — y de paso corrige una divergencia si alguien tocó el ajuste a mano.
 *
 * `<IncludeLineItems>` no es opcional: sin él QuickBooks devuelve sólo el header
 * y los `TxnLineID` llegan vacíos. Esa misma omisión, en el camino de invoices,
 * hizo que un force-sync tratara todas las líneas como nuevas y reemplazara el
 * documento entero. Acá el guard es explícito: header sin líneas y con importe
 * ⇒ se aborta, nunca se reconstruye.
 */

import { bridgeFetch, pollRawOperationResult } from "../client/core";

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function toRecords(raw: unknown): Array<Record<string, unknown>> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  return [raw as Record<string, unknown>];
}

function extractMessages(rawResult: unknown): Record<string, unknown> {
  const result = rawResult as Record<string, unknown> | null;
  const qbxml = result?.QBXML as Record<string, unknown> | undefined;
  return (
    (qbxml?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    (result?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    {}
  );
}

export interface DamageAdjustmentSnapshot {
  edit_sequence: string;
  /** ListID del ítem → TxnLineID de su línea viva en QuickBooks. */
  qb_line_ids: Record<string, string>;
  /** ListID del ítem → QuantityDifference actual en QuickBooks (negativo). */
  current_quantities: Record<string, number>;
  /** Orden autoritativo de líneas, tal como QuickBooks las devuelve. */
  qb_line_order: string[];
}

/**
 * Devuelve `null` si QuickBooks no conoce el TxnID (borrado a mano, o company
 * file equivocado). El caller decide qué hacer: es un estado terminal, no un
 * fallo reintentable, y tratarlo como fallo genera una fila muerta por tick.
 */
export async function fetchDamageAdjustmentSnapshot(
  txnId: string,
  logger: any
): Promise<DamageAdjustmentSnapshot | null> {
  const query = await bridgeFetch("POST", "/api/inventory-adjustments/query", {
    txn_id: txnId,
  });
  if (!query?.operationId) {
    throw new Error(
      "cm_damage_adjustment_mod: InventoryAdjustmentQuery returned no operationId"
    );
  }

  const raw = await pollRawOperationResult(query.operationId, (m) =>
    logger.info(`[cm-damage] ${m}`)
  );
  const msgs = extractMessages(
    (raw as Record<string, unknown> | null)?.result ?? raw
  );
  const rs = msgs.InventoryAdjustmentQueryRs as
    | Record<string, unknown>
    | undefined;

  const rets = toRecords(rs?.InventoryAdjustmentRet);
  const adj = rets.find((r) => str(r.TxnID) === txnId) ?? null;
  if (!adj) return null;

  const editSequence = str(adj.EditSequence);
  if (!editSequence) {
    throw new Error(
      `cm_damage_adjustment_mod: QuickBooks devolvió el ajuste ${txnId} sin EditSequence`
    );
  }

  const lines = toRecords(adj.InventoryAdjustmentLineRet);
  if (lines.length === 0) {
    // Un ajuste vivo SIEMPRE tiene líneas (QuickBooks no acepta uno sin ellas).
    // Cero líneas acá significa que la query no las pidió o que el ajuste ya
    // está voideado — en ninguno de los dos casos se puede armar un Mod.
    throw new Error(
      `cm_damage_adjustment_mod: el ajuste ${txnId} volvió sin líneas — no se reconstruye a ciegas`
    );
  }

  const qbLineIds: Record<string, string> = {};
  const currentQuantities: Record<string, number> = {};
  const qbLineOrder: string[] = [];

  for (const line of lines) {
    const itemRef = line.ItemRef as Record<string, unknown> | undefined;
    const listId = str(itemRef?.ListID);
    const txnLineId = str(line.TxnLineID);
    if (!listId || !txnLineId) continue;
    qbLineIds[listId] = txnLineId;
    const qty = Number(str(line.QuantityDifference) ?? "0");
    currentQuantities[listId] = Number.isFinite(qty) ? qty : 0;
    qbLineOrder.push(txnLineId);
  }

  return {
    edit_sequence: editSequence,
    qb_line_ids: qbLineIds,
    current_quantities: currentQuantities,
    qb_line_order: qbLineOrder,
  };
}

/**
 * ¿El Mod cambiaría algo? Compara el estado deseado contra el vivo de QB.
 *
 * Un Mod que no cambia nada no es inocuo: mueve el EditSequence y ensucia el
 * historial del documento. Y como el estado deseado se recalcula entero en cada
 * ruta que toca el credit memo, la mayoría de los enqueues son exactamente eso
 * — por ejemplo un edit que sólo cambió la cantidad DEVUELTA, con los mismos
 * defectuosos.
 */
export function damageModIsNoop(
  desiredByListId: Record<string, number>,
  snapshot: { current_quantities?: Record<string, number> }
): boolean {
  const current = snapshot.current_quantities;
  // Sin foto del estado vivo no se puede afirmar "no cambia nada" — y ante la
  // duda se despacha. Saltear un Mod que sí hacía falta deja QuickBooks mal en
  // silencio; mandar uno de más sólo mueve el EditSequence.
  if (!current) return false;

  const desiredKeys = Object.keys(desiredByListId).sort();
  const currentKeys = Object.keys(current).sort();
  if (desiredKeys.length !== currentKeys.length) return false;
  if (desiredKeys.some((k, i) => k !== currentKeys[i])) return false;
  return desiredKeys.every((k) => desiredByListId[k] === current[k]);
}
