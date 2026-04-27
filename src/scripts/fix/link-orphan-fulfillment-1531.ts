/**
 * link-orphan-fulfillment-1531.ts
 *
 * Order 1531 (invoice 20142) had its fulfillment row created but never got a
 * corresponding row in `order_fulfillment` (the link table). Medusa's order
 * query joins fulfillments via that link, so the fulfillment was invisible
 * to the orders API → the invoice list showed it as Pending even though
 * `fulfillment.delivered_at` is set.
 *
 * This script inserts the missing link with a Medusa-style ULID id.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/link-orphan-fulfillment-1531.ts
 */

import {
  ContainerRegistrationKeys,
} from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ulid } from "ulid";

const ORDER_ID = "order_01KQ02XMKN63J73JB6W5MSP7FK";
const FULFILLMENT_ID = "ful_01KQ02YSPZCTGHXRZFPDGJVXW7";

export default async function linkOrphanFulfillment({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as any;

  const exists = await knex.raw(
    `SELECT 1 FROM order_fulfillment WHERE order_id = ? AND fulfillment_id = ? LIMIT 1`,
    [ORDER_ID, FULFILLMENT_ID]
  ).then((r: any) => r.rows ?? r);

  if (exists.length) {
    logger.info(`[link-orphan] Already linked — nothing to do.`);
    return;
  }

  const linkId = `ordful_${ulid()}`;
  await knex.raw(
    `INSERT INTO order_fulfillment (id, order_id, fulfillment_id, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [linkId, ORDER_ID, FULFILLMENT_ID]
  );

  logger.info(
    `[link-orphan] ✅ Inserted link ${linkId} → order=${ORDER_ID} fulfillment=${FULFILLMENT_ID}`
  );
}
