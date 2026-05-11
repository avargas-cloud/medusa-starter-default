import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";

export type ResolveQbVendorListIdInput = {
  /** Internal qb_vendor.id values to resolve (may include duplicates or nulls). */
  vendor_qb_ids: (string | null)[];
};

export type ResolveQbVendorListIdOutput = {
  /** Maps each internal qb_vendor.id → its QB Desktop ListID (null if not found). */
  listIdByVendorId: Record<string, string | null>;
};

/**
 * Resolves internal qb_vendor.id values to their actual QuickBooks Desktop
 * ListIDs. QB Desktop rejects internal Medusa IDs (qbvnd_…) as PrefVendorRef
 * ListID — only the real QB-assigned ListID (e.g. "800012DF-1554221344") is valid.
 */
export const resolveQbVendorListIdStep = createStep(
  "resolve-qb-vendor-list-id",
  async (
    input: ResolveQbVendorListIdInput,
    { container }
  ): Promise<StepResponse<ResolveQbVendorListIdOutput>> => {
    const uniqueIds = [
      ...new Set(
        input.vendor_qb_ids.filter((id): id is string => Boolean(id))
      ),
    ];

    if (uniqueIds.length === 0) {
      return new StepResponse({ listIdByVendorId: {} });
    }

    const svc = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
    const vendors = await svc.listQbVendors(
      { id: uniqueIds },
      { select: ["id", "qb_list_id"] }
    );

    const listIdByVendorId: Record<string, string | null> = {};
    for (const v of vendors) {
      listIdByVendorId[v.id] = v.qb_list_id ?? null;
    }

    return new StepResponse({ listIdByVendorId });
  }
);
