import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { produceCalendarInvites } from "../lib/notifications/producers/calendar-invites";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[pos-notifications-calendar-invites]";

/** Cada 10 min: invitaciones de Google Calendar pendientes por cada staff del dominio → el invitado; resuelve las respondidas. Sin GMAIL_SERVICE_ACCOUNT_KEY no llama a Google. */
export default async function job(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger") as { info: (m: string) => void; warn: (m: string) => void };
  try {
    const summary = await produceCalendarInvites(getDbPool());
    if (summary.created > 0 || summary.resolved > 0 || summary.errors > 0) logger.info(`${TAG} ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.warn(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "pos-notifications-calendar-invites", schedule: "*/10 * * * *" };
