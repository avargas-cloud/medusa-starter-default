import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { resolveOrphanNotifications } from "../lib/notifications/producers/resolver";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-resolver]";

/** Cada 15 min: marca resolved_at en avisos cuya causa ya no existe (orden cancelada, pago anulado, fila QB recuperada, pendiente revisado). */
export default async function job(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await resolveOrphanNotifications(getDbPool());
    if (Object.values(summary).some((n) => n > 0)) logger.info(`${TAG} ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "pos-notifications-resolver", schedule: "*/15 * * * *" };
