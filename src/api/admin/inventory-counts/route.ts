/**
 * src/api/admin/inventory-counts/route.ts
 *
 * GET  /admin/inventory-counts  — paginated list with filters
 * POST /admin/inventory-counts  — create a new draft (cashier)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID } from "../../../modules/inventory-count/types";

import { getActorUserId, UnauthenticatedError } from "./_lib/auth";
import { buildEnrichmentMaps, decorateCount } from "./_lib/enrich";
import { formatCountNumber, zodErrorToBody } from "./_lib/format";
import { getInventoryCountService } from "./_lib/service-resolver";
import { createDraftSchema, listQuerySchema } from "./_lib/validators";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const filters = parsed.data;

  const service = getInventoryCountService(req);

  const where: Record<string, unknown> = {};
  if (filters.status) {
    const statuses = filters.status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length === 1) where.status = statuses[0];
    else if (statuses.length > 1) where.status = statuses;
  }
  if (filters.stock_location_id)
    where.stock_location_id = filters.stock_location_id;
  if (filters.created_by_user_id)
    where.created_by_user_id = filters.created_by_user_id;
  if (filters.reviewed_by_user_id)
    where.reviewed_by_user_id = filters.reviewed_by_user_id;
  if (filters.q) where.number = { $ilike: `%${filters.q}%` };

  const [rows, count] = await service.listAndCountInventoryCounts(where, {
    take: filters.limit,
    skip: filters.offset,
    order: { created_at: "DESC" },
  });

  const maps = await buildEnrichmentMaps(req, rows);
  const enriched = rows.map((r) => decorateCount(r, maps));

  return res.json({
    inventory_counts: enriched,
    count,
    limit: filters.limit,
    offset: filters.offset,
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getInventoryCountService(req);

  // Allocate the canonical INVCNT-{seq} number AT CREATION (matches the
  // convention used by estimates / invoices / sales receipts). Burning a
  // sequence value on a cancelled draft is acceptable — same trade-off as
  // the rest of the document family.
  const seq = await service.getNextSequence();
  const number = formatCountNumber(seq);

  const [created] = await service.createInventoryCounts([
    {
      number,
      seq,
      status: "draft",
      stock_location_id: body.stock_location_id,
      category_filter_id: body.category_filter_id ?? null,
      sku_prefix_filter: body.sku_prefix_filter ?? null,
      memo: null,
      default_qb_account_list_id:
        body.default_qb_account_list_id ??
        DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID,
      created_by_user_id: userId,
    },
  ]);

  return res.status(201).json({ inventory_count: created });
}
