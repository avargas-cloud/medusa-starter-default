import { getDbPool } from "../../api/utils/db-pool";

import { linksFromOrderMetadata, mergeLinks } from "./links";
import { lockReasonFromFacts } from "./predicate";
import {
  insertLockIfAbsent,
  loadOrderMetadata,
  loadOrderSettlementFacts,
  loadProjectSideLinks,
  type LockDb,
} from "./repo";
import type { LockReason, ProjectLink } from "./types";

export interface EvaluateResult {
  orderId: string;
  reason: LockReason | null;
  links: ProjectLink[];
  inserted: ProjectLink[];
}

/**
 * Decide y escribe el candado de TODOS los proyectos vinculados a una orden.
 * Idempotente: un candado que ya existe no se toca; una orden sin dinero ni
 * entregas no escribe nada. Nunca lanza hacia el caller de eventos: el
 * subscriber lo envuelve igual, pero acá se deja propagar para que el
 * reconciler y el verificador vean el error real.
 */
export async function evaluateProjectLocksForOrder(
  orderId: string,
  createdBy: string,
  db: LockDb = getDbPool()
): Promise<EvaluateResult> {
  const [facts, metadata, projectSide] = await Promise.all([
    loadOrderSettlementFacts(db, orderId),
    loadOrderMetadata(db, orderId),
    loadProjectSideLinks(db, orderId),
  ]);
  const links = mergeLinks(linksFromOrderMetadata(metadata), projectSide);
  const reason = lockReasonFromFacts(facts);
  const inserted: ProjectLink[] = [];
  if (!reason || links.length === 0) return { orderId, reason, links, inserted };

  for (const link of links) {
    const didInsert = await insertLockIfAbsent(db, {
      link,
      orderId,
      reason,
      createdBy,
      facts,
    });
    if (didInsert) inserted.push(link);
  }
  return { orderId, reason, links, inserted };
}
