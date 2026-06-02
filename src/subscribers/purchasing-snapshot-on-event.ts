/**
 * Subscriber: purchasing snapshot — targeted recalculation
 *
 * Recalculates snapshot only for the variants affected by an event,
 * instead of waiting for the nightly full run.
 *
 * Covered events:
 *   order.completed / order.canceled → tier0_30d + inventory changes
 *
 * NOTE: ABC/XYZ class (Pareto) is NOT re-run — it stays from the last
 * nightly full snapshot. Only sales metrics and inventory are updated.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import * as dotenv from "dotenv";
import { Client } from "pg";

import { recalculateForVariants } from "../services/purchasing/snapshot.service";

dotenv.config();

async function getVariantIdsForOrder(orderId: string): Promise<string[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const res = await db.query<{ variant_id: string }>(
      `SELECT DISTINCT oli.variant_id
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
       WHERE oi.order_id = $1 AND oli.variant_id IS NOT NULL`,
      [orderId]
    );
    return res.rows.map((r) => r.variant_id);
  } finally {
    await db.end();
  }
}

export default async function purchasingSnapshotOnEvent({
  event,
}: SubscriberArgs<{ id: string }>) {
  try {
    const orderId = event.data?.id;
    if (!orderId) return;

    const variantIds = await getVariantIdsForOrder(orderId);
    if (variantIds.length === 0) return;

    await recalculateForVariants(variantIds);
    console.log(
      `[purchasing-snapshot] Recalculated ${variantIds.length} variant(s) for order ${orderId}`
    );
  } catch (e) {
    console.error(
      `[purchasing-snapshot] Subscriber error: ${(e as Error).message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: ["order.completed", "order.canceled", "pos.order.fulfilled"],
};
