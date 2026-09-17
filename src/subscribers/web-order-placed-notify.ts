import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { getDbPool } from "../api/utils/db-pool";
import { produceWebOrderPlaced } from "../lib/notifications/producers/web-order";

const TAG = "[web-order-placed-notify]";

/**
 * order.placed (sólo web): rep `WEB` si no trae uno + notificación a todo el
 * staff. Las órdenes POS (`metadata.pos_created`) se saltean adentro del
 * productor. Nunca lanza: un aviso perdido no puede fallar el placement.
 */
export default async function webOrderPlacedNotify({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId = data?.id;
  if (!orderId) return;
  const logger = container.resolve("logger");
  try {
    const out = await produceWebOrderPlaced(getDbPool(), orderId);
    if (out.skipped) return;
    logger.info(
      `${TAG} order=${orderId} rep_assigned=${out.rep_assigned} created=${out.result?.created ?? false} recipients=${out.result?.recipient_user_ids.length ?? 0}`
    );
  } catch (err) {
    logger.error(`${TAG} order=${orderId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
  context: { subscriberId: "web-order-placed-notify" },
};
