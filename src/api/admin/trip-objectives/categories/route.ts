/**
 * GET  /admin/trip-objectives/categories   — list categories (for sidebar + forms)
 * POST /admin/trip-objectives/categories   — create a category (visual builder)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting } from "../_lib/guard";
import { resolveTripService } from "../_lib/service";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const includeInactive = req.query.include_inactive === "true";
  const filter = includeInactive ? {} : { is_active: true };
  const categories = await service.listTripObjectiveCategories(filter, {
    order: { position: "ASC" },
  });
  res.json({ categories });
}

type CreateCategoryBody = {
  slug?: string;
  label?: string;
  icon_key?: string;
  color_token?: string;
  field_schema?: unknown;
  status_set?: unknown;
  default_status_key?: string;
  position?: number;
};

export async function POST(
  req: AuthenticatedMedusaRequest<CreateCategoryBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const body = req.body ?? {};
  if (!body.slug || !body.label) {
    res.status(400).json({ error: "slug and label are required" });
    return;
  }
  const service = resolveTripService(req);
  const existing = await service.listTripObjectiveCategories({
    slug: body.slug,
  });
  if (existing.length > 0) {
    res.status(409).json({ error: `slug "${body.slug}" already exists` });
    return;
  }
  const category = await service.createTripObjectiveCategories({
    slug: body.slug,
    label: body.label,
    icon_key: body.icon_key || "target",
    color_token: body.color_token || "slate",
    field_schema: body.field_schema ?? [],
    status_set: body.status_set ?? [],
    default_status_key: body.default_status_key ?? null,
    position: typeof body.position === "number" ? body.position : 0,
    is_active: true,
  });
  res.status(201).json({ category });
}
