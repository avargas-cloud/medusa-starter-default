import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { ESTIMATE_HOUR, produceStaleEstimates } from "../lib/notifications/producers/estimates";
import { businessHour } from "../lib/notifications/producers/po-due-today";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-estimates]";

/**
 * Cada hora; produce a las 8 am ET (guard en hora de negocio, no en el cron):
 * estimates sin actividad 7+ días → su rep, y de nuevo cada 7 días (dedupe
 * por semana) mientras sigan abiertos.
 */
export default async function job(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (businessHour() !== ESTIMATE_HOUR) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await produceStaleEstimates(getDbPool());
    logger.info(`${TAG} scanned=${summary.scanned} created=${summary.created}`);
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "pos-notifications-estimates", schedule: "0 * * * *" };
