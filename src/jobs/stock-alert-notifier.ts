import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

import { getDbPool } from "../api/utils/db-pool";
import { isStockAlertsDisabled, notifyBackInStock } from "../lib/stock-alerts";
import { sendMail } from "../utils/mailer";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[stock-alert-notifier]";

/**
 * Cada 15 min: a quien pidió "avisame cuando vuelva el stock" desde el BOM de
 * las apps embebidas, le manda el email cuando su variante vuelve a tener
 * unidades en el canal de la web (user-stated 2026-09-11). Email REAL vía el
 * mailer de la casa (Resend); en sandbox `isMailDisabled()` lo frena adentro
 * de `sendMail`, que devuelve false y la alerta queda pendiente.
 */
export default async function stockAlertNotifier(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (isStockAlertsDisabled()) return;

  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
  };
  try {
    const summary = await notifyBackInStock({
      db: getDbPool(),
      query: container.resolve(ContainerRegistrationKeys.QUERY),
      send: (mail) => sendMail(mail),
      storeUrl: process.env.STOREFRONT_URL ?? "https://ecopowertech.com",
      storeName: "EcoPowerTech",
    });
    if (summary.candidates > 0) {
      logger.info(
        `${TAG} pending=${summary.candidates} channel=${summary.salesChannelId ?? "none"} ` +
          `to_notify=${summary.toNotify.length} notified=${summary.notified.length} failed=${summary.failed.length}`
      );
    }
  } catch (error: unknown) {
    logger.warn(`${TAG} failed: ${(error as Error).message}`);
  }
}

export const config = {
  name: "stock-alert-notifier",
  schedule: "*/15 * * * *",
};
