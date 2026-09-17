import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { produceAccountingNotifications } from "../lib/notifications/producers/accounting";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-accounting]";

/** Cada 5 min: commission requests pendientes, price batches submitted y refunds sin Write Check (últimas 24 h) → Accounting. */
export default async function job(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await produceAccountingNotifications(getDbPool());
    if (summary.created > 0) logger.info(`${TAG} ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "pos-notifications-accounting", schedule: "*/5 * * * *" };
