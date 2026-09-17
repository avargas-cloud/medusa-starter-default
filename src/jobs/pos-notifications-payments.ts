import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { producePaymentNotifications } from "../lib/notifications/producers/payments";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-payments]";

/**
 * Cada minuto: pagos de cliente aplicados a facturas (últimas 24 h) que aún
 * no tienen su notificación → campana de admins + rep. Idempotente por
 * `dedupe_key`; nunca toca `payment_application`.
 */
export default async function posNotificationsPayments(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await producePaymentNotifications(getDbPool());
    if (summary.created > 0) {
      logger.info(`${TAG} scanned=${summary.scanned} created=${summary.created}`);
    }
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = {
  name: "pos-notifications-payments",
  schedule: "*/1 * * * *",
};
