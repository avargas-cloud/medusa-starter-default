/**
 * GET    /admin/trip-objectives/objectives/:id  — one objective + its observations
 * PATCH  /admin/trip-objectives/objectives/:id  — update fields/status/image/etc
 * DELETE /admin/trip-objectives/objectives/:id  — soft-delete (cascades observations)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting, getActorUserId } from "../../_lib/guard";
import { resolveTripService } from "../../_lib/service";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const objective = await service.retrieveTripObjective(
    req.params.id as string
  );
  const observations = await service.listTripObjectiveObservations(
    { objective_id: req.params.id },
    { order: { occurred_at: "DESC" } }
  );
  res.json({ objective, observations });
}

type UpdateObjectiveBody = {
  title?: string;
  description?: string;
  status_key?: string;
  priority?: string;
  category_id?: string;
  group_id?: string | null;
  reference_image_url?: string | null;
  reference_image_key?: string | null;
  reference_image_thumb_url?: string | null;
  reference_image_thumb_key?: string | null;
  product_variant_id?: string | null;
  product_sku?: string | null;
  product_title?: string | null;
  product_thumbnail_url?: string | null;
  fields?: Record<string, unknown>;
  active_optional_fields?: string[];
  quotes?: unknown[];
  position?: number;
};

export async function PATCH(
  req: AuthenticatedMedusaRequest<UpdateObjectiveBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const body = req.body ?? {};

  const update: Record<string, unknown> = {
    id: req.params.id,
    updated_by_user_id: getActorUserId(req) ?? null,
  };
  for (const key of [
    "title",
    "description",
    "status_key",
    "priority",
    "category_id",
    "group_id",
    "reference_image_url",
    "reference_image_key",
    "reference_image_thumb_url",
    "reference_image_thumb_key",
    "product_variant_id",
    "product_sku",
    "product_title",
    "product_thumbnail_url",
    "fields",
    "active_optional_fields",
    "quotes",
    "position",
  ] as const) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const objective = await service.updateTripObjectives(update);
  res.json({ objective });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  await service.deleteTripObjectives(req.params.id as string);
  res.json({ id: req.params.id, deleted: true });
}
