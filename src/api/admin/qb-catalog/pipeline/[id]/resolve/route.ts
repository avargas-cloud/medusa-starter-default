import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

const bridgeUrl = (): string =>
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const apiKey = (): string =>
  process.env.QB_BRIDGE_API_KEY || process.env.QB_API_KEY || "";

type Row = {
  id: string;
  sku: string;
  op_action: "add" | "mod" | null;
  qb_id: string | null;
  op_payload: Record<string, unknown> | null;
};

/**
 * Re-query & resolve a stuck/looping item row SAFELY.
 *
 * For a MOD with a known ListID: fires a fresh ItemQuery against QB and parks the
 * row in `recovery_mode=editseq_query`. Phase A then resubmits the mod with the
 * CURRENT EditSequence. We do NOT mark `synced` just because an item exists in QB
 * — we re-validate by re-pushing the desired state with a fresh sequence, which
 * is the only way to guarantee QB matches Medusa (Codex review, 2026-05-29).
 *
 * For an ADD (no ListID yet): simply re-queue so Phase B re-dispatches the add
 * (name-in-use reconcile still kicks in automatically if it already exists).
 *
 * Either way submit_count is reset so the freed row gets a full budget again.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data: rows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: ["id", "sku", "op_action", "qb_id", "op_payload"],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as Row[])[0];
  if (!row) return res.status(404).json({ error: "Pipeline row not found" });
  if (!row.op_payload || !row.op_action) {
    return res.status(400).json({
      error: "Cannot resolve: row has no op_payload. Re-edit the item to enqueue a fresh op.",
    });
  }

  // ADD without ListID → just re-queue; Phase B handles dispatch + reconcile.
  if (row.op_action === "add" && !row.qb_id) {
    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "error",
      recovery_mode: "none",
      qb_operation_id: null,
      submit_count: 0,
      retries: 0,
      next_retry_at: null,
      failed_at: null,
      last_error: null,
    });
    return res.json({
      success: true,
      message: `${row.sku}: re-queued add — worker will dispatch within ~60s.`,
    });
  }

  if (!row.qb_id) {
    return res.status(400).json({
      error: "Cannot re-query: mod row has no ListID (qb_id). Use Retry instead.",
    });
  }

  // MOD → fire a fresh ItemQuery; Phase A resubmits with the current EditSequence.
  try {
    const iqRes = await fetch(`${bridgeUrl()}/api/products/${row.qb_id}`, {
      headers: { "x-api-key": apiKey(), "bypass-tunnel-reminder": "true" },
    });
    if (!iqRes.ok) {
      return res.status(502).json({
        success: false,
        error: `Bridge ItemQuery failed (HTTP ${iqRes.status})`,
      });
    }
    const iqJson = (await iqRes.json()) as { operationId?: string };
    if (!iqJson.operationId) {
      return res.status(502).json({ success: false, error: "Bridge returned no operationId" });
    }

    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "waiting",
      recovery_mode: "editseq_query",
      qb_operation_id: iqJson.operationId,
      submit_count: 0,
      retries: 0,
      last_error: null,
      last_error_code: null,
      next_retry_at: null,
      failed_at: null,
    });
    logger.info(
      `[pipeline resolve] ${row.sku}: re-query queued (op=${iqJson.operationId}) — Phase A will resubmit mod with fresh EditSequence`
    );
    return res.json({
      success: true,
      message: `${row.sku}: re-querying QB; the edit will re-sync with a fresh EditSequence within ~60s.`,
    });
  } catch (err: any) {
    logger.error(`[pipeline resolve] ${row.sku} failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
