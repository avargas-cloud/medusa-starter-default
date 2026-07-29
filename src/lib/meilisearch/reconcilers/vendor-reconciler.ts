import type { MedusaContainer } from "@medusajs/framework/types";
import type { EntityReconciler } from "../drift-reconciler";
import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../../modules/quickbooks-catalog/service";
import { updateSingleVendorMeiliWorkflow } from "../../../workflows/update-single-vendor-meili";
import { transformVendor, VENDORS_INDEX } from "../vendor-doc";

/**
 * `vendors` index reconciler — Capa 2 counterpart for `qb_vendor`.
 *
 * Until this shipped, vendor→Meili sync was callsite-based and only ONE of the
 * six qb_vendor writers actually called it (`PUT /admin/qb-catalog/vendors/:id`).
 * A vendor created from the POS or pulled by `qb-vendor-sync-runner` landed in
 * Postgres and stayed invisible in the `vendors` index forever — so the Factory
 * Order manufacturer picker and the PO vendor picker (both `searchVendors`)
 * could not find it. 20 vendors were missing when this was written.
 *
 * The trigger (`trg_meili_sync_qb_vendor`) is writer-agnostic: psql, fix
 * scripts, cron runners and routes all enqueue alike.
 */

/**
 * Builds the canonical `vendors` doc through the exact same `transformVendor`
 * mapping the single-vendor workflow and the bulk sync use — so drift
 * detection can never disagree with what a re-sync would write.
 */
async function buildExpectedVendorDoc(
  vendorId: string,
  container: MedusaContainer
): Promise<Record<string, unknown> | null> {
  const service = container.resolve(
    QUICKBOOKS_CATALOG_MODULE
  ) as unknown as QuickbooksCatalogModuleService;

  const vendor = await service.retrieveQbVendor(vendorId).catch(() => null);
  if (!vendor) return null;

  return transformVendor(vendor);
}

export const vendorReconciler: EntityReconciler = {
  entityType: "vendor",
  meiliIndex: "vendors",
  // What the vendor pickers show and search on. `updated_at`/`created_at` are
  // deliberately excluded — they change on every QB resync pass and would
  // report drift on every single row.
  comparableFields: [
    "qb_list_id",
    "full_name",
    "name",
    "company_name",
    "account_number",
    "is_active",
    "contact",
    "email",
    "phone",
    "city",
    "state",
    "terms_ref_name",
    "payment_terms",
    "vendor_type_ref_name",
    "sync_status",
  ],
  buildExpectedDoc: buildExpectedVendorDoc,
  syncOne: async (id, container) => {
    const service = container.resolve(
      QUICKBOOKS_CATALOG_MODULE
    ) as unknown as QuickbooksCatalogModuleService;

    // A SOFT delete (Medusa sets deleted_at) fires the trigger as an UPDATE,
    // not a DELETE — so the queue asks us to re-sync a row that retrieve no
    // longer returns. Drop the doc instead of letting it fail 5 times and
    // dead-letter with a stale vendor left searchable.
    const vendor = await service.retrieveQbVendor(id).catch(() => null);
    if (!vendor) {
      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });
      await client.index(VENDORS_INDEX).deleteDocument(id);
      return;
    }

    // Delegate to the canonical workflow — keeps the mapping single-sourced.
    // The workflow's step swallows its own errors and reports success:false,
    // so re-throw here: the queue processor must see a failure to retry it
    // instead of marking the row processed with a stale Meili doc.
    const { result } = await updateSingleVendorMeiliWorkflow(container).run({
      input: { vendor_id: id },
    });
    if (!(result as { success?: boolean })?.success) {
      throw new Error(`vendor meili upsert failed for ${id}`);
    }
  },
  fetchUpdatedIdsSince: async (sql, sinceIso, limit) => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM qb_vendor
      WHERE deleted_at IS NULL
        AND updated_at >= ${sinceIso}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },
};
