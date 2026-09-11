import { getDbPool } from "../../api/utils/db-pool";

import { evaluateProjectLocksForOrder, type EvaluateResult } from "./evaluate";
import { listOrdersWithUnlockedLinks, type LockDb } from "./repo";

export interface ReconcileSummary {
  candidates: number;
  locked: number;
  results: EvaluateResult[];
}

/**
 * Red de seguridad del subscriber: recorre las órdenes vinculadas sin candado
 * y evalúa cada una. Cubre (a) capturas y entregas que no emiten un evento
 * que el subscriber escuche, (b) vínculos escritos sólo del lado del proyecto
 * y (c) los proyectos ya cobrados al momento del deploy (≈12 medidos el
 * 2026-09-10) — esa es su primera corrida en producción.
 */
export async function reconcileProjectOrderLocks(
  options: { limit?: number; createdBy?: string; db?: LockDb } = {}
): Promise<ReconcileSummary> {
  const db = options.db ?? getDbPool();
  const createdBy = options.createdBy ?? "reconciler";
  const orderIds = await listOrdersWithUnlockedLinks(db, options.limit ?? 200);
  const results: EvaluateResult[] = [];
  let locked = 0;
  for (const orderId of orderIds) {
    const result = await evaluateProjectLocksForOrder(orderId, createdBy, db);
    results.push(result);
    locked += result.inserted.length;
  }
  return { candidates: orderIds.length, locked, results };
}
