import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { detectDrift } from "../../../../../lib/meilisearch/drift-detection";
import { syncCustomersWorkflow } from "../../../../../workflows/sync-customers";

/**
 * POST /admin/search/customers/sync
 *
 * Drift check + non-destructive full sync for the `customers` index.
 * Honors ?force=true (unlike the previous implementation which ignored it).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const customerModule = req.scope.resolve("customer");
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const force = req.query.force === "true";

    const customers = await customerModule.listCustomers(
      {},
      {
        select: ["id", "updated_at"],
        order: { updated_at: "DESC" },
        take: 50000,
      }
    );

    const dbDocs = customers.map((c: any) => ({ id: c.id as string }));
    const dbLatestMs = customers[0]
      ? new Date(customers[0].updated_at).getTime()
      : 0;

    const drift = await detectDrift({
      client,
      indexName: "customers",
      dbDocs,
      dbLatestMs,
      force,
      // Customer updates are bursty; a 2s tolerance keeps noise down
      // without missing genuine drift.
      toleranceMs: 2000,
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    });

    console.log(
      `🔍 [Customers Sync] db=${drift.dbCount} meili=${drift.meiliCount} ` +
        `timeDiff=${drift.timeDiffMs}ms drift=${drift.driftMismatches}/${drift.driftSampleSize} ` +
        `reason=${drift.reason}`
    );

    if (!drift.shouldSync) {
      return res.json({
        success: true,
        synced: 0,
        status: "already_synced",
        message: "Customers already in sync",
        dbCount: drift.dbCount,
        meiliCount: drift.meiliCount,
      });
    }

    const { result } = await syncCustomersWorkflow(req.scope).run();
    return res.json({
      success: true,
      synced: result.synced,
      status: "synced_now",
      message: "Customers synced",
      reason: drift.reason,
      dbCount: drift.dbCount,
      meiliCount: drift.meiliCount,
    });
  } catch (error) {
    console.error(
      "[MeiliSearch Customer Sync Error]:",
      (error as Error).message
    );
    return res.status(500).json({
      success: false,
      error: "Sync failed",
      message: (error as Error).message,
    });
  }
};

export const AUTHENTICATE = ["user"];
