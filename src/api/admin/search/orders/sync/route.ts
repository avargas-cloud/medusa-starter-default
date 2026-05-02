import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { syncAllOrdersToMeili } from "../../../../../lib/meilisearch/sync-orders-runner";

/**
 * POST /admin/search/orders/sync
 *
 * Manual recovery: re-syncs every order in the database to the
 * `orders` MeiliSearch index. Wired to the "Resync Orders" button on
 * the POS Settings page. Idempotent.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const result = await syncAllOrdersToMeili(req.scope as any);
    return res.json({
      success: true,
      synced: result.synced,
      total: result.total,
      message: `Orders synced (${result.synced}/${result.total})`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: "sync_failed",
      message: err?.message || "Unknown error",
    });
  }
};

export const AUTHENTICATE = ["user"];
