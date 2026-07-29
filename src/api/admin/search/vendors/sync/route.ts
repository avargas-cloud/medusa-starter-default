import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../../../../modules/quickbooks-catalog/service";
import { syncVendorsToMeiliWorkflow } from "../../../../../workflows/sync-vendors-meilisearch";
import { VENDORS_INDEX } from "../../../../../lib/meilisearch/vendor-doc";

/**
 * POST /admin/search/vendors/sync
 *
 * Non-destructive full re-index of the `vendors` index — the one that backs
 * every vendor picker (Factory Order manufacturer, Purchase Order vendor).
 * Powers the "Resync Vendors" row in the POS Settings → Search Index card.
 *
 * Reports how many vendors were MISSING before the run, because that is the
 * number the operator actually cares about: a vendor in Postgres but not in
 * this index is invisible in every picker.
 *
 * Day to day this should report 0 missing — `trg_meili_sync_qb_vendor` keeps
 * the index current regardless of which writer touched the row. This button is
 * the manual escape hatch.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const service = req.scope.resolve(
      QUICKBOOKS_CATALOG_MODULE
    ) as unknown as QuickbooksCatalogModuleService;

    const vendors = (await service.listQbVendors(
      {},
      { take: 100000 }
    )) as unknown as { id: string }[];

    // getDocuments().total is the accurate count — a search's
    // estimatedTotalHits is capped by the index's maxTotalHits and lies above
    // it.
    const docs = await client
      .index(VENDORS_INDEX)
      .getDocuments({ limit: 100000, fields: ["id"] });
    const present = new Set((docs.results as { id: string }[]).map((d) => d.id));
    const missingBefore = vendors.filter((v) => !present.has(v.id)).length;

    const { result } = await syncVendorsToMeiliWorkflow(req.scope).run();
    const synced = (result as { synced?: number })?.synced ?? 0;

    return res.json({
      success: true,
      synced,
      missingBefore,
      dbCount: vendors.length,
      meiliCount: docs.total,
      status: missingBefore > 0 ? "repaired" : "already_synced",
      message:
        missingBefore > 0
          ? `${missingBefore} vendor(s) were missing from search — re-indexed`
          : "Vendors already searchable",
    });
  } catch (error) {
    console.error("[MeiliSearch Vendor Sync Error]:", (error as Error).message);
    return res.status(500).json({
      success: false,
      error: "Sync failed",
      message: (error as Error).message,
    });
  }
};

export const AUTHENTICATE = ["user"];
