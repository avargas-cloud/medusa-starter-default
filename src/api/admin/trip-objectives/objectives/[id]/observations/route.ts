/**
 * GET  /admin/trip-objectives/objectives/:id/observations  — list (newest first)
 * POST /admin/trip-objectives/objectives/:id/observations  — add a dated note
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting, getActorUserId } from "../../../_lib/guard";
import { resolveTripService } from "../../../_lib/service";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const observations = await service.listTripObjectiveObservations(
    { objective_id: req.params.id },
    { order: { occurred_at: "DESC" } }
  );
  res.json({ observations });
}

type Party = { name: string; type?: string; vendor_id?: string };
type CreateObservationBody = {
  occurred_at?: string;
  note?: string;
  parties?: Party[];
};

export async function POST(
  req: AuthenticatedMedusaRequest<CreateObservationBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const body = req.body ?? {};

  if (!body.note || !body.note.trim()) {
    res.status(400).json({ error: "note is required" });
    return;
  }

  const observation = await service.createTripObjectiveObservations({
    objective_id: req.params.id,
    occurred_at: body.occurred_at ?? new Date().toISOString(),
    note: body.note.trim(),
    parties: Array.isArray(body.parties) ? body.parties : [],
    created_by_user_id: getActorUserId(req) ?? null,
  });
  res.status(201).json({ observation });
}
