/**
 * src/workflows/sync-vendors-meilisearch.ts
 *
 * Re-indexes the `vendors` Meilisearch index from the `qb_vendor` DB
 * table. Matches the pattern of sync-customers.ts — single-batch upsert
 * with a process-local in-memory lock to avoid concurrent runs.
 *
 * Idempotent — safe to rerun at any time. Designed to be invoked from:
 *   - manual exec script: scripts/sync/sync-vendors-meilisearch.ts
 *   - future cron job
 */

import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../modules/quickbooks-catalog/service";
import { transformVendor, VENDORS_INDEX } from "../lib/meilisearch/vendor-doc";

let isSyncing = false;

interface VendorRow {
  id: string;
  qb_list_id?: string | null;
  full_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean;
  sync_status?: string | null;
  updated_at?: Date | string | null;
  created_at?: Date | string | null;
  [key: string]: unknown;
}

export const syncVendorsToMeiliStep = createStep(
  "sync-vendors-to-meili-step",
  async (_input, { container }) => {
    if (isSyncing) {
      console.log(
        "⚠️ Vendor sync requested but already in progress. Skipping."
      );
      return new StepResponse({
        success: false,
        message: "Sync already in progress",
        synced: 0,
      });
    }

    isSyncing = true;
    console.log("🔒 Acquired Vendor Sync Lock");

    try {
      const { MeiliSearch } = await import("meilisearch");
      const service = container.resolve(
        QUICKBOOKS_CATALOG_MODULE
      ) as unknown as QuickbooksCatalogModuleService;

      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });
      const index = client.index(VENDORS_INDEX);

      await index.updateSettings({
        filterableAttributes: [
          "is_active",
          "sync_status",
          "state",
          "country",
          "vendor_type_ref_name",
        ],
        sortableAttributes: ["full_name", "created_at", "updated_at"],
        searchableAttributes: [
          "full_name",
          "name",
          "company_name",
          "email",
          "phone",
          "qb_list_id",
          "account_number",
          "contact",
          "city",
        ],
        rankingRules: [
          "words",
          "typo",
          "proximity",
          "attribute",
          "sort",
          "exactness",
        ],
      });

      const vendors = (await service.listQbVendors(
        {},
        { take: 100000 }
      )) as unknown as VendorRow[];

      if (vendors.length === 0) {
        console.log("ℹ️ No vendors to sync.");
        return new StepResponse({
          success: true,
          message: "No vendors",
          synced: 0,
        });
      }

      const documents = vendors.map(transformVendor);
      await index.addDocuments(documents, { primaryKey: "id" });

      console.log(`✅ Upserted ${documents.length} vendors into Meili.`);
      return new StepResponse({
        success: true,
        message: `${documents.length} vendors synced`,
        synced: documents.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("❌ Vendor Meili sync failed:", msg);
      throw err;
    } finally {
      isSyncing = false;
      console.log("🔓 Released Vendor Sync Lock");
    }
  }
);

export const syncVendorsToMeiliWorkflow = createWorkflow(
  "sync-vendors-to-meili",
  function () {
    const result = syncVendorsToMeiliStep();
    return new WorkflowResponse(result);
  }
);
