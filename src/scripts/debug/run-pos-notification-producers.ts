/**
 * Corre los productores de notificaciones del POS a mano (sandbox / E2E).
 *
 *   env DATABASE_URL=<sandbox> ./node_modules/.bin/medusa exec ./src/scripts/debug/run-pos-notification-producers.ts
 *
 * Env:
 *   PRODUCERS=payments,po_due,qb_failures,web_order,accounting,estimates,calendar,resolver
 *                                                      (default: payments,po_due,qb_failures)
 *   WEB_ORDER_ID=order_…                               (obligatorio para web_order)
 *   FORCE_PO_DUE=1                                     (saltea el guard de las 7 am)
 *
 * Escribe SÓLO en pos_notification / pos_notification_recipient (y el rep WEB
 * de la orden pedida). Contra producción sólo con el checkpoint del plan.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { producePaymentNotifications } from "../../lib/notifications/producers/payments";
import { producePoDueToday } from "../../lib/notifications/producers/po-due-today";
import { produceQbFailureNotifications } from "../../lib/notifications/producers/qb-failures";
import { produceWebOrderPlaced } from "../../lib/notifications/producers/web-order";
import { produceAccountingNotifications } from "../../lib/notifications/producers/accounting";
import { produceStaleEstimates } from "../../lib/notifications/producers/estimates";
import { produceCalendarInvites } from "../../lib/notifications/producers/calendar-invites";
import { resolveOrphanNotifications } from "../../lib/notifications/producers/resolver";

export default async function runPosNotificationProducers({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve("logger") as { info: (m: string) => void };
  const db = getDbPool();
  const wanted = new Set(
    (process.env.PRODUCERS ?? "payments,po_due,qb_failures").split(",").map((s) => s.trim())
  );
  if (wanted.has("payments")) {
    const r = await producePaymentNotifications(db);
    logger.info(`payments: scanned=${r.scanned} created=${r.created}`);
  }
  if (wanted.has("po_due")) {
    const r = await producePoDueToday(db, { force: process.env.FORCE_PO_DUE === "1" });
    logger.info(`po_due: skipped=${r.skipped} date=${r.ymd} matched=${r.matched} created=${r.result?.created ?? false}`);
  }
  if (wanted.has("qb_failures")) {
    const r = await produceQbFailureNotifications(db);
    logger.info(`qb_failures: scanned=${r.scanned} created=${r.created}`);
  }
  if (wanted.has("accounting")) {
    const r = await produceAccountingNotifications(db);
    logger.info(`accounting: scanned=${r.scanned} created=${r.created}`);
  }
  if (wanted.has("estimates")) {
    const r = await produceStaleEstimates(db);
    logger.info(`estimates: scanned=${r.scanned} created=${r.created}`);
  }
  if (wanted.has("calendar")) {
    const r = await produceCalendarInvites(db);
    logger.info(`calendar: ${JSON.stringify(r)}`);
  }
  if (wanted.has("resolver")) {
    const r = await resolveOrphanNotifications(db);
    logger.info(`resolver: ${JSON.stringify(r)}`);
  }
  if (wanted.has("web_order")) {
    const id = process.env.WEB_ORDER_ID;
    if (!id) throw new Error("WEB_ORDER_ID is required for the web_order producer");
    const r = await produceWebOrderPlaced(db, id);
    logger.info(`web_order: skipped=${r.skipped} rep_assigned=${r.rep_assigned} created=${r.result?.created ?? false}`);
  }
}
