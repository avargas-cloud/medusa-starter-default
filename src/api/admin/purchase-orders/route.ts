/**
 * src/api/admin/purchase-orders/route.ts
 *
 * GET  /admin/purchase-orders  — paginated list with filters
 * POST /admin/purchase-orders  — create a draft PurchaseOrder + lines
 *
 * Drafts carry no PO number until the submit workflow promotes them to
 * `submitted` — matches the inventory-count convention.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "./_lib/auth";
import { zodErrorToBody } from "./_lib/format";
import { getPurchaseOrdersService } from "./_lib/service-resolver";
import { computeTotals, normalizeLine } from "./_lib/totals";
import {
  ALLOWED_STATUS_VALUES,
  createDraftSchema,
  listQuerySchema,
} from "./_lib/validators";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const q = parsed.data;

  const service = getPurchaseOrdersService(req);

  const where: Record<string, unknown> = {};
  if (q.status) {
    const statuses = q.status
      .split(",")
      .map((s) => s.trim())
      .filter((s) => (ALLOWED_STATUS_VALUES as readonly string[]).includes(s));
    if (statuses.length === 1) where.status = statuses[0];
    else if (statuses.length > 1) where.status = statuses;
  }
  if (q.vendor_id) where.vendor_id = q.vendor_id;
  if (q.stock_location_id) where.stock_location_id = q.stock_location_id;
  if (q.created_by_user_id) where.created_by_user_id = q.created_by_user_id;
  if (q.q) where.number = { $ilike: `%${q.q}%` };

  const createdAt: Record<string, Date> = {};
  if (q.from) createdAt.$gte = new Date(q.from);
  if (q.to) createdAt.$lte = new Date(q.to);
  if (Object.keys(createdAt).length > 0) where.created_at = createdAt;

  const [rows, count] = await service.listAndCountPurchaseOrders(where, {
    take: q.limit,
    skip: q.offset,
    order: { created_at: "DESC" },
  });

  return res.json({
    purchase_orders: rows,
    count,
    limit: q.limit,
    offset: q.offset,
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
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const normalized = body.lines.map(normalizeLine);
  const totals = computeTotals(normalized, {
    shipping_cents: body.shipping_cents,
    tax_cents: body.tax_cents,
    other_fees_cents: body.other_fees_cents,
  });

  const [po] = await service.createPurchaseOrders([
    {
      status: "draft",
      vendor_id: body.vendor_id,
      stock_location_id: body.stock_location_id,
      ordered_at: body.ordered_at ? new Date(body.ordered_at) : null,
      expected_at: body.expected_at ? new Date(body.expected_at) : null,
      memo: body.memo ?? null,
      reference_number: body.reference_number ?? null,
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      shipping_cents: totals.shipping_cents,
      other_fees_cents: totals.other_fees_cents,
      total_cents: totals.total_cents,
      total_lines: totals.total_lines,
      total_units_ordered: totals.total_units_ordered,
      created_by_user_id: userId,
    },
  ]);

  if (!po) {
    return res
      .status(500)
      .json({ error: "Failed to create draft", code: "create_failed" });
  }

  if (normalized.length > 0) {
    await service.createPurchaseOrderLines(
      normalized.map((l, i) => ({
        purchase_order_id: po.id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qb_item_list_id_snapshot: l.qb_item_list_id_snapshot ?? null,
        qty_ordered: l.qty_ordered,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: l.unit_cost_cents,
        tax_cents: l.tax_cents ?? 0,
        total_cents: l.total_cents,
        status: "open",
        line_order: l.line_order ?? i,
        notes: l.notes ?? null,
      }))
    );
  }

  return res.status(201).json({ purchase_order: po });
}
