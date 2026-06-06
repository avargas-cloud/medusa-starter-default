/**
 * GET  /admin/trip-objectives/objectives?trip_id=&category=<slug|id>&status=
 * POST /admin/trip-objectives/objectives
 *
 * `category` accepts a slug (preferred, from the URL) or a raw category id.
 * If trip_id is omitted, the active trip is used.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertAccounting, getActorUserId } from "../_lib/guard";
import { resolveTripService } from "../_lib/service";

async function resolveCategoryId(
  service: ReturnType<typeof resolveTripService>,
  category: string | undefined
): Promise<string | undefined> {
  if (!category) return undefined;
  if (category.startsWith("tobjcat_")) return category;
  const cats = await service.listTripObjectiveCategories({ slug: category });
  return cats[0]?.id;
}

async function resolveTripId(
  service: ReturnType<typeof resolveTripService>,
  tripId: string | undefined
): Promise<string | undefined> {
  if (tripId) return tripId;
  const trips = await service.listTrips({ is_active: true });
  return trips[0]?.id;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);

  const tripId = await resolveTripId(
    service,
    req.query.trip_id as string | undefined
  );
  const categoryId = await resolveCategoryId(
    service,
    req.query.category as string | undefined
  );

  const filter: Record<string, unknown> = {};
  if (tripId) filter.trip_id = tripId;
  if (categoryId) filter.category_id = categoryId;
  if (req.query.status) filter.status_key = req.query.status;

  const objectives = await service.listTripObjectives(filter, {
    order: { position: "ASC", created_at: "DESC" },
  });
  res.json({ objectives, count: objectives.length });
}

type CreateObjectiveBody = {
  category_id?: string;
  category?: string;
  trip_id?: string;
  title?: string;
  description?: string;
  status_key?: string;
  priority?: string;
  reference_image_url?: string;
  reference_image_key?: string;
  reference_image_thumb_url?: string;
  reference_image_thumb_key?: string;
  product_variant_id?: string;
  product_sku?: string;
  product_title?: string;
  product_thumbnail_url?: string;
  fields?: Record<string, unknown>;
  active_optional_fields?: string[];
  quotes?: unknown[];
  position?: number;
};

export async function POST(
  req: AuthenticatedMedusaRequest<CreateObjectiveBody>,
  res: MedusaResponse
) {
  if (!(await assertAccounting(req, res))) return;
  const service = resolveTripService(req);
  const body = req.body ?? {};

  if (!body.title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const categoryId =
    body.category_id ?? (await resolveCategoryId(service, body.category));
  if (!categoryId) {
    res.status(400).json({ error: "category_id (or category slug) is required" });
    return;
  }
  const tripId = await resolveTripId(service, body.trip_id);
  if (!tripId) {
    res
      .status(400)
      .json({ error: "no active trip — create a trip first" });
    return;
  }

  // Default status from the category if not provided.
  const category = await service.retrieveTripObjectiveCategory(categoryId);
  const statusKey = body.status_key ?? category.default_status_key ?? null;

  const objective = await service.createTripObjectives({
    trip_id: tripId,
    category_id: categoryId,
    title: body.title,
    description: body.description ?? null,
    status_key: statusKey,
    priority: body.priority ?? "normal",
    reference_image_url: body.reference_image_url ?? null,
    reference_image_key: body.reference_image_key ?? null,
    reference_image_thumb_url: body.reference_image_thumb_url ?? null,
    reference_image_thumb_key: body.reference_image_thumb_key ?? null,
    product_variant_id: body.product_variant_id ?? null,
    product_sku: body.product_sku ?? null,
    product_title: body.product_title ?? null,
    product_thumbnail_url: body.product_thumbnail_url ?? null,
    fields: body.fields ?? {},
    active_optional_fields: body.active_optional_fields ?? [],
    quotes: Array.isArray(body.quotes) ? body.quotes : [],
    position: typeof body.position === "number" ? body.position : 0,
    created_by_user_id: getActorUserId(req) ?? null,
    updated_by_user_id: getActorUserId(req) ?? null,
  });
  res.status(201).json({ objective });
}
