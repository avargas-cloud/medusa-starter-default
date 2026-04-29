/**
 * PATCH  /admin/landing-costs/:id/lines/:lineId — edit qty/cost/desc/cbm/sku/mpn
 * DELETE /admin/landing-costs/:id/lines/:lineId — remove a row
 *
 * Editing a row does NOT auto-recalculate landed columns; the user must
 * trigger /recalculate. This keeps the UI snappy during bulk edits.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../../../purchase-orders/_lib/format";
import { getLandingCostsService } from "../../../_lib/service-resolver";

const patchSchema = z
  .object({
    sku: z.string().max(200).optional(),
    mpn: z.string().max(200).nullish(),
    description: z.string().max(500).optional(),
    qty: z.number().int().min(1).optional(),
    unit_cost_cents: z.number().int().min(0).optional(),
    cbm_per_unit: z.number().min(0).max(100).nullish(),
  })
  .partial();

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getLandingCostsService(req);

  const lines = (await service.listLandingCostLines(
    { id: lineId, landing_cost_id: id },
    { take: 1 }
  )) as unknown as Array<{ id: string }>;
  if (!lines[0]) {
    return res
      .status(404)
      .json({ error: "Line not found", code: "not_found" });
  }

  await service.updateLandingCostLines({
    selector: { id: lineId },
    data: body,
  });

  const updated = (await service.retrieveLandingCostLine(
    lineId
  )) as unknown as Record<string, unknown>;

  return res.json({ landing_cost_line: updated });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const service = getLandingCostsService(req);

  const lines = (await service.listLandingCostLines(
    { id: lineId, landing_cost_id: id },
    { take: 1 }
  )) as unknown as Array<{ id: string }>;
  if (!lines[0]) {
    return res
      .status(404)
      .json({ error: "Line not found", code: "not_found" });
  }

  await service.deleteLandingCostLines(lineId);

  return res.json({ id: lineId, deleted: true });
}
