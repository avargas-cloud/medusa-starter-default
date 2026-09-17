import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { purgeNotifications } from "../lib/notifications/producers/purge";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-purge]";

/** Diario 04:20 UTC: archiva lo leído/resuelto > 30 días y borra lo > 180 días sin no leídas. */
export default async function job(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await purgeNotifications(getDbPool());
    logger.info(`${TAG} archived=${summary.archived} deleted=${summary.deleted}`);
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "pos-notifications-purge", schedule: "20 4 * * *" };
