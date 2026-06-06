/**
 * GET    /admin/trip-objectives/categories/:id  — one category
 * PATCH  /admin/trip-objectives/categories/:id  — update (visual field builder)
 * DELETE /admin/trip-objectives/categories/:id  — deactivate (soft)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting } from "../../_lib/guard";
import { resolveTripService } from "../../_lib/service";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const category = await service.retrieveTripObjectiveCategory(
    req.params.id as string
  );
  res.json({ category });
}

type UpdateCategoryBody = {
  label?: string;
  icon_key?: string;
  color_token?: string;
  field_schema?: unknown;
  status_set?: unknown;
  default_status_key?: string;
  position?: number;
  is_active?: boolean;
};

export async function PATCH(
  req: AuthenticatedMedusaRequest<UpdateCategoryBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const body = req.body ?? {};

  const update: Record<string, unknown> = { id: req.params.id };
  for (const key of [
    "label",
    "icon_key",
    "color_token",
    "field_schema",
    "status_set",
    "default_status_key",
    "position",
    "is_active",
  ] as const) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const category = await service.updateTripObjectiveCategories(update);
  res.json({ category });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  // Soft-deactivate so existing objectives keep their category reference.
  const category = await service.updateTripObjectiveCategories({
    id: req.params.id,
    is_active: false,
  });
  res.json({ category, deactivated: true });
}
