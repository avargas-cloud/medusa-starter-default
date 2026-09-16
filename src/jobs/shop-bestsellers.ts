import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { computeOrders12m, writeOrders12m } from "../lib/shop/bestsellers";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

export const config = {
  name: "shop-bestsellers",
  // 07:00 UTC = 03:00 EDT / 02:00 EST — corre después del cierre nocturno del
  // POS y antes de que arranque el tráfico de la mañana en Miami, así el
  // ranking de "bestsellers" de la tienda ya está fresco cuando abren.
  schedule: "0 7 * * *",
};

export default async function shopBestsellersJob(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = console;
  try {
    const pool = getDbPool();
    const rows = await computeOrders12m(pool);
    const { updated } = await writeOrders12m(pool, rows);

    let topProductId: string | null = null;
    let topOrders = -1;
    for (const [productId, counts] of rows) {
      if (counts.orders > topOrders) {
        topOrders = counts.orders;
        topProductId = productId;
      }
    }

    let topTitle = "n/a";
    if (topProductId) {
      const titleResult = await pool.query<{ title: string }>(
        `SELECT title FROM product WHERE id = $1`,
        [topProductId]
      );
      topTitle = titleResult.rows[0]?.title ?? "n/a";
    }

    logger.info(
      `[shop-bestsellers] ✓ ${rows.size} products, ${updated} changed, top: ${topTitle} (${Math.max(topOrders, 0)})`
    );
  } catch (e) {
    logger.error(`[shop-bestsellers] ✗ ${(e as Error).message}`);
  }
}
