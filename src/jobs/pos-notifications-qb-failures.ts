import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { produceQbFailureNotifications } from "../lib/notifications/producers/qb-failures";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-qb-failures]";

/**
 * Cada 5 min: filas de `qb_order_pipeline` en `failed` (últimas 24 h) sin
 * aviso para esa fila+error → campana del owner. Sólo lee el pipeline.
 */
export default async function posNotificationsQbFailures(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await produceQbFailureNotifications(getDbPool());
    if (summary.created > 0) {
      logger.info(`${TAG} scanned=${summary.scanned} created=${summary.created}`);
    }
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = {
  name: "pos-notifications-qb-failures",
  schedule: "*/5 * * * *",
};
