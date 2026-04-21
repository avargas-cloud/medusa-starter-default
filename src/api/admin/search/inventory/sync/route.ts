import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { detectDrift } from "../../../../../lib/meilisearch/drift-detection";
import { syncInventoryWorkflow } from "../../../../../workflows/sync-inventory";

/**
 * POST /admin/search/inventory/sync
 *
 * Drift check + non-destructive full sync for the `inventory` index.
 * Now checks count + timestamp + content sample, where the previous
 * implementation only checked count (and missed silent doc mutations).
 *
 * The content sample looks at `variantId` specifically — the field that
 * powers the edit modal's variant resolution. A wiped or wrong
 * `variantId` is the most common way this index drifts silently.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const query = req.scope.resolve("query") as any;
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const force = req.query.force === "true";

    // Build the DB doc snapshot the same way syncInventoryWorkflow does.
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "updated_at",
        "product.id",
        "inventory_items.inventory.id",
        "inventory_items.inventory.updated_at",
      ],
    });

    type Doc = { id: string; variantId: string; updatedAtMs: number };
    const inventoryLinked: Doc[] = variants.flatMap((v: any) =>
      (v.inventory_items ?? [])
        .filter((ii: any) => ii.inventory?.id)
        .map((ii: any) => ({
          id: ii.inventory.id as string,
          variantId: v.id as string,
          updatedAtMs: new Date(
            ii.inventory.updated_at ?? v.updated_at
          ).getTime(),
        }))
    );
    const synthetic: Doc[] = variants
      .filter(
        (v: any) =>
          (!v.inventory_items || v.inventory_items.length === 0) &&
          v.sku &&
          v.product?.id
      )
      .map((v: any) => ({
        id: v.id as string,
        variantId: v.id as string,
        updatedAtMs: new Date(v.updated_at).getTime(),
      }));

    const dbDocs = [...inventoryLinked, ...synthetic];
    const dbLatestMs = dbDocs.reduce(
      (m, d) => (d.updatedAtMs > m ? d.updatedAtMs : m),
      0
    );

    const drift = await detectDrift({
      client,
      indexName: "inventory",
      dbDocs,
      dbLatestMs,
      force,
      sampleFields: ["variantId"],
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    });

    console.log(
      `🔍 [Inventory Sync] db=${drift.dbCount} meili=${drift.meiliCount} ` +
        `timeDiff=${drift.timeDiffMs}ms drift=${drift.driftMismatches}/${drift.driftSampleSize} ` +
        `reason=${drift.reason}`
    );

    if (!drift.shouldSync) {
      return res.json({
        success: true,
        synced: 0,
        status: "already_synced",
        message: "Inventory already in sync",
        dbCount: drift.dbCount,
        meiliCount: drift.meiliCount,
      });
    }

    const { result } = await syncInventoryWorkflow(req.scope).run({
      input: {},
    });
    return res.json({
      ...result,
      status: "synced_now",
      reason: drift.reason,
      dbCount: drift.dbCount,
      meiliCount: drift.meiliCount,
    });
  } catch (error) {
    console.error(
      "[MeiliSearch Inventory Sync Error]:",
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
