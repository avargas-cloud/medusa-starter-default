import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import {
  validateCostOverridesDelta,
  applyCostOverridesDelta,
} from "../../../../../lib/pos/cost-overrides";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/orders/:id/cost-overrides — delta atómico de cost overrides.
 *
 * Body: { set?: Record<string, number>, remove?: string[] }
 * Responde el objeto canónico resultante: { cost_overrides: {...} }.
 *
 * Sólo órdenes REALES (is_draft_order = false); los estimates van por
 * /admin/draft-orders/:id/cost-overrides. Ver lib/pos/cost-overrides.ts para
 * el porqué del delta (carrera de saves concurrentes del PriceCalcModal).
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
  const result = await applyCostOverridesDelta(getDbPool(), id, false, v.delta);
  if (!result.found) {
    res.status(404).json({ error: `Order ${id} not found (or is a draft)` });
    return;
  }
  res.json({ cost_overrides: result.costOverrides });
}
