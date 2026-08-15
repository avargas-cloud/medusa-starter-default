import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import {
  validateCostOverridesDelta,
  applyCostOverridesDelta,
} from "../../../../../lib/pos/cost-overrides";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/draft-orders/:id/cost-overrides — delta atómico de cost
 * overrides para ESTIMATES (is_draft_order = true). Espejo exacto de
 * /admin/orders/:id/cost-overrides; ver ese route y lib/pos/cost-overrides.ts.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const v = validateCostOverridesDelta(req.body);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const result = await applyCostOverridesDelta(getDbPool(), id, true, v.delta);
  if (!result.found) {
    res.status(404).json({ error: `Draft order ${id} not found (or is not a draft)` });
    return;
  }
  res.json({ cost_overrides: result.costOverrides });
}
