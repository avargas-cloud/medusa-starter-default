import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { getBusinessDateString } from "../../date/et";
import { bridgeFetch } from "./core";
import { damageModIsNoop } from "../damage/refresh-damage-snapshot";

export interface AdjustmentGroupPayload {
  count_id: string;
  count_number: string;
  count_memo: string;
  qb_account_list_id: string;
  qb_inventory_site_list_id?: string;
  /** Frozen at enqueue time (YYYY-MM-DD). Used as QB TxnDate so late-synced
   *  or retried adjustments land on the approval date, not today. */
  txn_date?: string;
  lines: Array<{
    line_id: string;
    inventory_item_id: string;
    product_variant_id: string;
    sku: string;
    delta_applied: number;
    new_stock: number;
  }>;
}

const DEFAULT_INVENTORY_SITE_LIST_ID = "80000001-1331053531";

function buildRefNumber(payload: AdjustmentGroupPayload): string {
  const num = payload.count_number || payload.count_id;
  const match = num.match(/(\d+)$/);
  if (match) return `IC${match[1]}`.slice(0, 11);
  return num.slice(0, 11);
}

function buildMemo(payload: AdjustmentGroupPayload): string {
  const base = `Count ${payload.count_number}`;
  return payload.count_memo
    ? `${base} — ${payload.count_memo}`.slice(0, 4095)
    : base;
}

/** Lo mínimo que necesita el resolver de ListIDs — lo cumplen el payload del
 *  conteo físico y el de defectuosos de un credit memo por igual. */
interface ListIdResolvableLine {
  sku: string;
  product_variant_id: string;
}

async function resolveQbListIds(
  payload: { lines: ListIdResolvableLine[] },
  container: MedusaContainer
): Promise<{ map: Map<string, string>; missing: string[] }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const skus = payload.lines.map((l) => l.sku);
  const map = new Map<string, string>();

  // Primary: qb_item_pipeline (status=synced) — POS Product Creation V2
  const { data: itemRows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: ["sku", "qb_list_id"],
    filters: { sku: skus, status: "synced" } as any,
    pagination: { skip: 0, take: skus.length },
  });
  for (const r of itemRows as Array<{ sku: string; qb_list_id: string | null }>) {
    if (r.qb_list_id) map.set(r.sku, r.qb_list_id);
  }

  // Fallback: product_variant.metadata.quickbooks_id (~2555 of 2564 bulk-imported items)
  const stillMissing = payload.lines.filter((l) => !map.has(l.sku));
  if (stillMissing.length > 0) {
    const { data: variantRows } = await query.graph({
      entity: "product_variant",
      fields: ["sku", "metadata"],
      filters: { id: stillMissing.map((l) => l.product_variant_id) } as any,
      pagination: { skip: 0, take: stillMissing.length },
    });
    for (const v of variantRows as Array<{
      sku: string | null;
      metadata: Record<string, unknown> | null;
    }>) {
      const qbId = v.metadata?.quickbooks_id;
      if (typeof qbId === "string" && qbId.length > 0 && v.sku) {
        map.set(v.sku, qbId);
      }
    }
  }

  const missing = payload.lines
    .filter((l) => !map.has(l.sku))
    .map((l) => l.sku);

  return { map, missing };
}

export async function postInventoryAdjustmentToQb(
  pipelineRowId: string,
  payload: AdjustmentGroupPayload,
  container: MedusaContainer,
  logger: any
): Promise<{ success: true; operationId: string } | { success: false; error: string }> {
  const { map: qbListIds, missing } = await resolveQbListIds(payload, container);

  if (missing.length > 0) {
    const skuList = missing.slice(0, 10).join(", ");
    return {
      success: false,
      error: `${missing.length} item(s) have no QB ListID (not in qb_item_pipeline or variant.metadata.quickbooks_id): ${skuList}`,
    };
  }

  try {
    const res = await bridgeFetch("POST", "/api/inventory-adjustments", {
      external_id: pipelineRowId,
      ref_number: buildRefNumber(payload),
      memo: buildMemo(payload),
      txn_date: payload.txn_date ?? getBusinessDateString(),
      account_list_id: payload.qb_account_list_id,
      inventory_site_list_id:
        payload.qb_inventory_site_list_id ?? DEFAULT_INVENTORY_SITE_LIST_ID,
      lines: payload.lines.map((l) => ({
        qb_list_id: qbListIds.get(l.sku) as string,
        new_quantity: l.new_stock,
      })),
    });

    if (!res?.success || !res?.operationId) {
      return {
        success: false,
        error: res?.error ?? "Bridge POST /api/inventory-adjustments returned no operationId",
      };
    }

    logger.info(
      `[QB-INV-ADJ] postInventoryAdjustmentToQb row=${pipelineRowId} op=${res.operationId}`
    );
    return { success: true, operationId: res.operationId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Defectuosos de un credit memo ───────────────────────────────────────────
//
// Un credit memo posee UN InventoryAdjustment durante toda su vida. El Add lo
// crea y el Mod lo edita; nunca hay un segundo documento.
//
// Diferencia con el conteo físico, y es la que importa: acá se manda
// `quantity_difference` (delta signado), NUNCA `new_quantity`. El POS sabe
// cuántas unidades se escriben a pérdida; NO sabe el on-hand de QuickBooks, y
// un absoluto pisaría cualquier venta o recepción que QB haya registrado en el
// medio.

export interface DamageAdjustmentLine {
  sku: string;
  product_variant_id: string;
  /** Unidades defectuosas (positivo). Se manda a QB negado. */
  damaged_qty: number;
}

export interface DamageAdjustmentAddPayload {
  credit_memo_id: string;
  credit_memo_number: string;
  qb_account_list_id: string;
  ref_number: string;
  memo: string;
  txn_date: string;
  lines: DamageAdjustmentLine[];
}

export interface DamageAdjustmentModPayload extends DamageAdjustmentAddPayload {
  txn_id: string;
  edit_sequence: string;
  /**
   * Identidad de cada línea VIVA en QuickBooks, leída del propio QB justo antes
   * del dispatch: ListID del ítem → TxnLineID. Lo que no aparezca acá es línea
   * nueva y va con '-1'; lo que aparezca acá y no esté en `lines` se OMITE, que
   * es como QuickBooks borra una línea.
   */
  qb_line_ids: Record<string, string>;
  /** Orden autoritativo de líneas leído de QB (misma defensa que el 3290). */
  qb_line_order?: string[];
  /** ListID → QuantityDifference que QuickBooks tiene AHORA. Habilita saltear un no-op. */
  current_quantities?: Record<string, number>;
}

export async function postDamageAdjustmentAddToQb(
  pipelineRowId: string,
  payload: DamageAdjustmentAddPayload,
  container: MedusaContainer,
  logger: any
): Promise<{ success: true; operationId: string } | { success: false; error: string }> {
  const { map: qbListIds, missing } = await resolveQbListIds(payload, container);
  if (missing.length > 0) {
    return {
      success: false,
      error: `${missing.length} item(s) have no QB ListID: ${missing.slice(0, 10).join(", ")}`,
    };
  }

  try {
    const res = await bridgeFetch(
      "POST",
      "/api/inventory-adjustments",
      {
        external_id: pipelineRowId,
        ref_number: payload.ref_number,
        memo: payload.memo,
        txn_date: payload.txn_date,
        account_list_id: payload.qb_account_list_id,
        lines: payload.lines.map((l) => ({
          qb_list_id: qbListIds.get(l.sku) as string,
          quantity_difference: -Math.abs(Math.trunc(l.damaged_qty)),
        })),
      },
      // Un InventoryAdjustmentAdd NO es idempotente: dos submits son dos
      // documentos. La key es 1:1 con el credit memo, que es 1:1 con su ajuste.
      { idempotencyKey: `cm-damage-adjustment:${payload.credit_memo_id}` }
    );

    if (!res?.success || !res?.operationId) {
      return {
        success: false,
        error: res?.error ?? "Bridge POST /api/inventory-adjustments returned no operationId",
      };
    }
    logger.info(
      `[QB-CM-DAMAGE] add row=${pipelineRowId} cm=${payload.credit_memo_number} op=${res.operationId}`
    );
    return { success: true, operationId: res.operationId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function postDamageAdjustmentModToQb(
  pipelineRowId: string,
  payload: DamageAdjustmentModPayload,
  container: MedusaContainer,
  logger: any
): Promise<
  | { success: true; operationId: string; noop?: false }
  | { success: true; noop: true }
  | { success: false; error: string }
> {
  const { map: qbListIds, missing } = await resolveQbListIds(payload, container);
  if (missing.length > 0) {
    return {
      success: false,
      error: `${missing.length} item(s) have no QB ListID: ${missing.slice(0, 10).join(", ")}`,
    };
  }

  // Estado deseado keyeado por ListID — la misma clave con la que QuickBooks
  // identifica sus líneas, para poder compararlo con lo que ya tiene.
  const desiredByListId: Record<string, number> = {};
  for (const l of payload.lines) {
    const listId = qbListIds.get(l.sku) as string;
    desiredByListId[listId] =
      (desiredByListId[listId] ?? 0) - Math.abs(Math.trunc(l.damaged_qty));
  }

  // Un Mod que no cambia nada mueve el EditSequence y ensucia el historial del
  // documento sin motivo. Y es el caso COMÚN: cada ruta que toca el credit memo
  // recalcula el estado entero, así que un edit que sólo cambió la cantidad
  // devuelta llega hasta acá con los mismos defectuosos de siempre.
  if (payload.current_quantities && damageModIsNoop(desiredByListId, payload)) {
    logger.info(
      `[QB-CM-DAMAGE] mod row=${pipelineRowId} cm=${payload.credit_memo_number} — sin cambios contra QuickBooks, no se despacha`
    );
    return { success: true, noop: true };
  }

  // `lines` es el estado COMPLETO deseado: QuickBooks borra toda línea cuyo
  // TxnLineID no venga. Una línea cuyo ListID no esté en `qb_line_ids` es nueva.
  const lines = Object.entries(desiredByListId).map(([listId, qty]) => {
    const existingLineId = payload.qb_line_ids[listId];
    return {
      txn_line_id: existingLineId ?? "-1",
      ...(existingLineId ? {} : { qb_list_id: listId }),
      quantity_difference: qty,
    };
  });

  try {
    const res = await bridgeFetch("POST", "/api/inventory-adjustments/mod", {
      external_id: pipelineRowId,
      txn_id: payload.txn_id,
      edit_sequence: payload.edit_sequence,
      account_list_id: payload.qb_account_list_id,
      txn_date: payload.txn_date,
      ref_number: payload.ref_number,
      memo: payload.memo,
      qb_line_order: payload.qb_line_order,
      lines,
    });

    if (!res?.success || !res?.operationId) {
      return {
        success: false,
        error: res?.error ?? "Bridge POST /api/inventory-adjustments/mod returned no operationId",
      };
    }
    logger.info(
      `[QB-CM-DAMAGE] mod row=${pipelineRowId} cm=${payload.credit_memo_number} txn=${payload.txn_id} op=${res.operationId}`
    );
    return { success: true, operationId: res.operationId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Lee un InventoryAdjustment de QuickBooks: EditSequence y la identidad viva de
 * sus líneas. Read-only.
 *
 * Se llama en CADA intento de Mod, nunca al encolar: el EditSequence de QB se
 * mueve con cualquier edición (incluida una hecha a mano en QuickBooks Desktop)
 * y un valor cacheado da 3200.
 */
export async function queryInventoryAdjustmentInQb(
  txnId: string
): Promise<{ success: true; operationId: string } | { success: false; error: string }> {
  try {
    const res = await bridgeFetch("POST", "/api/inventory-adjustments/query", {
      txn_id: txnId,
    });
    if (!res?.success || !res?.operationId) {
      return {
        success: false,
        error: res?.error ?? "Bridge POST /api/inventory-adjustments/query returned no operationId",
      };
    }
    return { success: true, operationId: res.operationId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function voidInventoryAdjustmentInQb(
  pipelineRowId: string,
  qbTxnId: string
): Promise<{ success: true; operationId: string } | { success: false; error: string }> {
  try {
    const res = await bridgeFetch("POST", "/api/inventory-adjustments/void", {
      external_id: `void:${pipelineRowId}`,
      txn_id: qbTxnId,
    });

    if (!res?.success || !res?.operationId) {
      return {
        success: false,
        error: res?.error ?? "Bridge POST /api/inventory-adjustments/void returned no operationId",
      };
    }

    return { success: true, operationId: res.operationId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
