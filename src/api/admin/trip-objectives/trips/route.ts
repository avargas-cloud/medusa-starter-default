/**
 * GET  /admin/trip-objectives/trips   — list trips (active first)
 * POST /admin/trip-objectives/trips   — create a trip
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting, getActorUserId } from "../_lib/guard";
import { resolveTripService } from "../_lib/service";
import { DEFAULT_TRIP_TIMEZONE } from "../../../../modules/trip-objectives/types";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const trips = await service.listTrips(
    {},
    { order: { is_active: "DESC", created_at: "DESC" } }
  );
  res.json({ trips, active: trips.find((t) => t.is_active) ?? null });
}

type CreateTripBody = {
  name?: string;
  destination?: string;
  timezone?: string;
  starts_at?: string;
  ends_at?: string;
  is_active?: boolean;
};

export async function POST(
  req: AuthenticatedMedusaRequest<CreateTripBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const body = req.body ?? {};
  if (!body.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const service = resolveTripService(req);
  const trip = await service.createTrips({
    name: body.name,
    destination: body.destination ?? null,
    timezone: body.timezone || DEFAULT_TRIP_TIMEZONE,
    starts_at: body.starts_at ?? null,
    ends_at: body.ends_at ?? null,
    status: body.is_active ? "active" : "planned",
    is_active: Boolean(body.is_active),
    created_by_user_id: getActorUserId(req) ?? null,
  });
  res.status(201).json({ trip });
}
