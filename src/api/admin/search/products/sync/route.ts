import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { detectDrift } from "../../../../../lib/meilisearch/drift-detection";
import { syncProductsWorkflow } from "../../../../../workflows/sync-products";

/**
 * POST /admin/search/products/sync
 *
 * Checks drift between the `products` MeiliSearch index and the Medusa DB
 * using the shared detectDrift helper (count + timestamp + content sample).
 * If drift is detected OR ?force=true is passed, runs the non-destructive
 * safeSync workflow that upserts and cleans up orphans.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const productModule = req.scope.resolve("product");
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const force = req.query.force === "true";

    // Fetch the DB snapshot — minimal fields to keep memory low, enough to
    // drive the drift sample (we use `id` only).
    const products = await productModule.listProducts(
      {},
      {
        select: ["id", "updated_at"],
        order: { updated_at: "DESC" },
        take: 50000,
      }
    );

    const dbDocs = products.map((p: any) => ({ id: p.id as string }));
    const dbLatestMs = products[0]
      ? new Date(products[0].updated_at).getTime()
      : 0;

    const drift = await detectDrift({
      client,
      indexName: "products",
      dbDocs,
      dbLatestMs,
      force,
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    });

    console.log(
      `🔍 [Products Sync] db=${drift.dbCount} meili=${drift.meiliCount} ` +
        `timeDiff=${drift.timeDiffMs}ms drift=${drift.driftMismatches}/${drift.driftSampleSize} ` +
        `reason=${drift.reason}`
    );

    if (!drift.shouldSync) {
      return res.json({
        success: true,
        synced: 0,
        status: "already_synced",
        message: "Products already in sync",
        dbCount: drift.dbCount,
        meiliCount: drift.meiliCount,
      });
    }

    const { result } = await syncProductsWorkflow(req.scope).run();
    return res.json({
      success: true,
      synced: result.synced,
      status: "synced_now",
      message: "Products synced",
      reason: drift.reason,
      dbCount: drift.dbCount,
      meiliCount: drift.meiliCount,
    });
  } catch (error) {
    console.error("[MeiliSearch Sync Error]:", (error as Error).message);
    return res.status(500).json({
      success: false,
      error: "Sync failed",
      message: (error as Error).message,
    });
  }
};

export const AUTHENTICATE = ["user"];
