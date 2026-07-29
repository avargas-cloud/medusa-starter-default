/**
 * src/workflows/update-single-vendor-meili.ts
 *
 * Re-indexes a single qb_vendor row into the Meilisearch `vendors`
 * index. Invoke from vendor mutation routes after a successful DB
 * write (create / update / force-resync) and from the background
 * sync runner when a vendor transitions to `synced`.
 *
 * Logs errors but does not re-throw them inside the step, so the
 * caller's primary response path is not affected if Meili is down.
 */

import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../modules/quickbooks-catalog/service";
import { transformVendor, VENDORS_INDEX } from "../lib/meilisearch/vendor-doc";

interface Input {
  vendor_id: string;
}

interface VendorRow {
  id: string;
  qb_list_id?: string | null;
  full_name?: string | null;
  [key: string]: unknown;
}

export const upsertSingleVendorToMeiliStep = createStep(
  "upsert-single-vendor-to-meili",
  async (input: Input, { container }) => {
    try {
      const { MeiliSearch } = await import("meilisearch");
      const service = container.resolve(
        QUICKBOOKS_CATALOG_MODULE
      ) as unknown as QuickbooksCatalogModuleService;

      const vendor = (await service
        .retrieveQbVendor(input.vendor_id)
        .catch(() => null)) as unknown as VendorRow | null;
      if (!vendor) {
        console.warn(
          `[update-single-vendor-meili] vendor ${input.vendor_id} not found`
        );
        return new StepResponse({ success: false });
      }

      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });
      const index = client.index(VENDORS_INDEX);
      await index.addDocuments([transformVendor(vendor)], { primaryKey: "id" });

      return new StepResponse({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[update-single-vendor-meili] sync failed for ${input.vendor_id}: ${msg}`
      );
      return new StepResponse({ success: false });
    }
  }
);

export const updateSingleVendorMeiliWorkflow = createWorkflow(
  "update-single-vendor-meili",
  function (input: Input) {
    const result = upsertSingleVendorToMeiliStep(input);
    return new WorkflowResponse(result);
  }
);
