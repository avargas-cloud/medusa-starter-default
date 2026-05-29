import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

/**
 * Force a pipeline row to `failed_permanent` — the manual kill-switch for a row
 * that is looping, wedged, or known-bad and should stop being auto-processed.
 *
 * Keeps a full audit trail (who, when, why, prior status) appended to last_error
 * so evidence is never lost. Does NOT clear op_payload — a later manual Retry can
 * still revive it. Mirrors the PO pipeline's mark-fixed action for parity.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;
  const reason =
    (req.body as { reason?: string } | undefined)?.reason?.trim() ||
    "no reason provided";
  const actor =
    (req as any).auth_context?.actor_id ??
    (req as any).auth_context?.app_metadata?.user_id ??
    "unknown";

  const { data: rows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: ["id", "sku", "status", "last_error"],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as Array<{ id: string; sku: string; status: string; last_error: string | null }>)[0];
  if (!row) return res.status(404).json({ error: "Pipeline row not found" });

  const stamp = new Date().toISOString();
  const audit =
    `[force-fail ${stamp} by ${actor}] reason: ${reason} ` +
    `(was '${row.status}')` +
    (row.last_error ? ` · prior error: ${row.last_error}` : "");

  try {
    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "failed_permanent",
      recovery_mode: "none",
      qb_operation_id: null,
      next_retry_at: null,
      failed_at: new Date(),
      last_error: audit,
    });
    logger.warn(`[pipeline force-fail] ${row.sku}: ${audit}`);
    return res.json({
      success: true,
      message: `${row.sku} marked failed_permanent. Use Retry to revive if needed.`,
    });
  } catch (err: any) {
    logger.error(`[pipeline force-fail] ${row.sku} failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
