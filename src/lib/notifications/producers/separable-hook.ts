/**
 * Los dos puntos de contacto con `receive/route.ts`, envueltos para que un
 * fallo de notificaciones jamás toque el recibo: cada uno traga y loguea.
 */
import { getDbPool } from "../../../api/utils/db-pool";

import {
  candidateOrdersForItems,
  parseLinkedOrderIds,
  produceSeparableAfterReceipt,
  snapshotSeparation,
  type RawSql,
} from "./separable";

export interface SeparationBefore {
  orderIds: string[];
  before: Map<string, { pending: number; available: number }>;
}

const TAG = "[pos-notifications:separable]";

export async function separationBeforeReceipt(
  pg: RawSql,
  inventoryItemIds: string[],
  linkedOrderIdsRaw: string | null | undefined
): Promise<SeparationBefore> {
  try {
    const orderIds = await candidateOrdersForItems(pg, inventoryItemIds, parseLinkedOrderIds(linkedOrderIdsRaw));
    const before = orderIds.length ? await snapshotSeparation(pg, orderIds) : new Map();
    return { orderIds, before };
  } catch (err) {
    console.warn(`${TAG} before-snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return { orderIds: [], before: new Map() };
  }
}

export async function notifySeparableAfterReceipt(
  pg: RawSql,
  snapshot: SeparationBefore,
  receipt: { id: string; number: string | null; po_number: string | null }
): Promise<void> {
  if (snapshot.orderIds.length === 0) return;
  try {
    const out = await produceSeparableAfterReceipt(getDbPool(), pg, { receipt, before: snapshot.before, orderIds: snapshot.orderIds });
    if (out.crossed.length > 0) {
      console.info(`${TAG} receipt=${receipt.number ?? receipt.id} separable=${out.crossed.join(",")}`);
    }
  } catch (err) {
    console.warn(`${TAG} after-receipt failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
