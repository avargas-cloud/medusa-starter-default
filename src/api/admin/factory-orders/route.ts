/**
 * GET  /admin/factory-orders  — paginated list with filters
 * POST /admin/factory-orders  — create a draft FactoryOrder + lines
 *
 * stock_location_id is always China Warehouse (FACTORY_ORDER_STOCK_LOCATION_ID).
 * The body never accepts it — the handler injects it unconditionally.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { FACTORY_ORDER_STOCK_LOCATION_ID } from "../../../modules/factory-orders/constants";
import { getActorUserId, UnauthenticatedError } from "./_lib/auth";
import { zodErrorToBody } from "./_lib/format";
import { getFactoryOrdersService } from "./_lib/service-resolver";
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

  const service = getFactoryOrdersService(req);

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
  if (q.created_by_user_id) where.created_by_user_id = q.created_by_user_id;
  if (q.q) where.number = { $ilike: `%${q.q}%` };

  const createdAt: Record<string, Date> = {};
  if (q.from) createdAt.$gte = new Date(q.from);
  if (q.to) createdAt.$lte = new Date(q.to);
  if (Object.keys(createdAt).length > 0) where.created_at = createdAt;

  const [rows, count] = await service.listAndCountFactoryOrders(where, {
    take: q.limit,
    skip: q.offset,
    order: { created_at: "DESC" },
  });

  return res.json({
    factory_orders: rows,
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

  const service = getFactoryOrdersService(req);

  const normalized = body.lines.map(normalizeLine);
  const totals = computeTotals(normalized, {
    shipping_cents: body.shipping_cents,
    tax_cents: body.tax_cents,
    other_fees_cents: body.other_fees_cents,
  });

  // Resolve vendor name snapshot from qb_vendor (reused as factory vendor catalog)
  const qbCatalog = req.scope.resolve("quickbooks_catalog") as unknown as {
    retrieveQbVendor: (id: string) => Promise<{
      qb_list_id: string | null;
      full_name: string | null;
      name: string;
      company_name: string | null;
    } | null>;
  };
  let vendorRow = await qbCatalog
    .retrieveQbVendor(body.vendor_id)
    .catch(() => null);

  if (!vendorRow) {
    const knex = (req.scope as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }).resolve("__pg_connection__");
    const rows = await knex
      .raw(
        `SELECT qb_list_id, full_name, name, company_name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [body.vendor_id]
      )
      .then((r) => r.rows as Array<Record<string, string | null>>);
    if (rows.length > 0) vendorRow = rows[0] as NonNullable<typeof vendorRow>;
  }

  const vendorNameSnapshot = vendorRow
    ? (vendorRow.company_name ?? vendorRow.full_name ?? vendorRow.name ?? null)
    : null;
  const vendorListIdSnapshot = vendorRow?.qb_list_id ?? null;

  const draftSeq = await service.getNextDraftSequence();
  const number = `FOD-${draftSeq}`;

  const [fo] = await service.createFactoryOrders([
    {
      status: "draft",
      number,
      draft_number: number,
      seq: null,
      vendor_id: body.vendor_id,
      vendor_name_snapshot: vendorNameSnapshot,
      vendor_list_id_snapshot: vendorListIdSnapshot,
      stock_location_id: FACTORY_ORDER_STOCK_LOCATION_ID,
      ordered_at: body.ordered_at ? new Date(body.ordered_at) : null,
      expected_at: body.expected_at ? new Date(body.expected_at) : null,
      memo: body.memo ?? null,
      reference_number: body.reference_number ?? null,
      po_status: body.po_status ?? null,
      linked_order_ids: body.linked_order_ids?.length
        ? JSON.stringify(body.linked_order_ids)
        : null,
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

  if (!fo) {
    return res
      .status(500)
      .json({ error: "Failed to create draft", code: "create_failed" });
  }

  if (normalized.length > 0) {
    await service.createFactoryOrderLines(
      normalized.map((l, i) => ({
        factory_order_id: fo.id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
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

  return res.status(201).json({ factory_order: fo });
}
