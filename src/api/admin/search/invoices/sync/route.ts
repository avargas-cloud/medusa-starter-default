import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { syncAllPosInvoicesToMeili } from "../../../../../lib/meilisearch/sync-pos-invoices-runner";

/**
 * POST /admin/search/invoices/sync
 *
 * Manual recovery: re-syncs every pos_invoice (denormalized with linked
 * order + customer) to the `pos_invoices` MeiliSearch index. Wired to
 * the "Resync Invoices" button on the POS Settings page. Idempotent.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const result = await syncAllPosInvoicesToMeili(req.scope as any);
    return res.json({
      success: true,
      synced: result.synced,
      total: result.total,
      message: `Invoices synced (${result.synced}/${result.total})`,
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
