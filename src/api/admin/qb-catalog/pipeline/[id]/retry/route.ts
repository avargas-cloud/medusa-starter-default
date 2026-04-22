import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

type PipelineRow = {
  id: string;
  variant_id: string;
  sku: string;
  item_type: "Inventory" | "Service" | "NonInventory";
  status: string;
  retries: number;
  op_action: "add" | "mod" | null;
  op_payload: Record<string, unknown> | null;
};

/**
 * Manual Retry — resets the row so the next pipeline-poller tick will pick it
 * up immediately. The poller (Phase B) handles the actual bridge resubmit and
 * EditSequence auto-fallback. Resetting `retries: 0` gives the user a fresh
 * 5-attempt budget; clearing `next_retry_at` makes it due NOW; clearing
 * `failed_permanent` revives previously dead rows.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data: rows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "variant_id",
      "sku",
      "item_type",
      "status",
      "retries",
      "op_action",
      "op_payload",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as PipelineRow[])[0];
  if (!row) return res.status(404).json({ error: "Pipeline row not found" });

  if (!row.op_payload || !row.op_action) {
    return res.status(400).json({
      error:
        "Cannot retry: pipeline row predates the retry-payload migration. " +
        "Re-edit the item to enqueue a fresh op.",
    });
  }

  try {
    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "error",
      retries: 0,
      next_retry_at: null,
      failed_at: null,
      last_error: row.status === "failed_permanent"
        ? "Manually revived from failed_permanent"
        : "Manually re-queued",
    });

    logger.info(
      `[pipeline retry] ${row.sku} (${row.op_action}) re-queued — ` +
        `worker will process within ~60s`
    );

    return res.json({
      success: true,
      message: `Re-queued ${row.sku} (${row.op_action}). ` +
        `Pipeline worker will process within ~60s.`,
    });
  } catch (err: any) {
    logger.error(`[pipeline retry] ${row.sku} failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
