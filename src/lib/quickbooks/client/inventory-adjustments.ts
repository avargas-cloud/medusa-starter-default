import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { bridgeFetch } from "./core";

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

async function resolveQbListIds(
  payload: AdjustmentGroupPayload,
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
      txn_date: payload.txn_date ?? new Date().toISOString().slice(0, 10),
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
