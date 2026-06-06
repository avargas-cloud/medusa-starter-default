/**
 * DELETE /admin/trip-objectives/observations/:id  — remove a single observation
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting } from "../../_lib/guard";
import { resolveTripService } from "../../_lib/service";

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  await service.deleteTripObjectiveObservations(req.params.id as string);
  res.json({ id: req.params.id, deleted: true });
}
