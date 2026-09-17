import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { producePoDueToday } from "../lib/notifications/producers/po-due-today";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-po-due-today]";

/**
 * Cada hora en punto; produce SÓLO cuando son las 7 en hora del negocio
 * (America/New_York — el guard vive en el productor, no en el cron, para
 * que el DST no lo corra). Una notificación agrupada por día → admins.
 */
export default async function posNotificationsPoDueToday(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await producePoDueToday(getDbPool());
    if (!summary.skipped) {
      logger.info(
        `${TAG} date=${summary.ymd} matched=${summary.matched} created=${summary.result?.created ?? false}`
      );
    }
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = {
  name: "pos-notifications-po-due-today",
  schedule: "0 * * * *",
};
