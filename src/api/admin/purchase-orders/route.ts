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
import { enrichBilledStatusMap } from "./_lib/billed-status";
import { enrichChinaTransferMap } from "./_lib/china-transfer";
import { zodErrorToBody } from "./_lib/format";
import { getPurchaseOrdersService } from "./_lib/service-resolver";
import { computeTotals, normalizeLine } from "./_lib/totals";
import {
  enrichTrackingSummaryMap,
  type TrackingSummary,
} from "./_lib/tracking-summary";
import {
  ALLOWED_STATUS_VALUES,
  createDraftSchema,
  listQuerySchema,
} from "./_lib/validators";
import { resolveVendorDisplayName } from "../../../lib/vendors/vendor-display-name";

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

  // Billed filter (owner 2026-07-24): billed_status is DERIVED (enrichment,
  // not a column), so filtering happens by pre-computing every PO's status
  // with the SAME lib the page decoration uses (single grouped query — the
  // table is small) and constraining ids. Keeps pagination/counts exact and
  // the two computations definitionally identical.
  if (q.billed) {
    const knexForFilter = (req.scope as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }).resolve("__pg_connection__");
    const allPos = (await knexForFilter.raw(
      `SELECT id, status, total_units_received FROM purchase_order WHERE deleted_at IS NULL`
    )).rows as Array<{ id: string; status: string; total_units_received: number | null }>;
    const allMap = await enrichBilledStatusMap(knexForFilter, allPos);
    const matching = allPos
      .filter((p) => (allMap.get(p.id)?.billed_status ?? "no") === q.billed)
      .map((p) => p.id);
    if (matching.length === 0) {
      return res.json({ purchase_orders: [], count: 0, limit: q.limit, offset: q.offset });
    }
    where.id = matching;
  }

  const [rows, count] = await service.listAndCountPurchaseOrders(where, {
    take: q.limit,
    skip: q.offset,
    order: { created_at: "DESC" },
  });

  // Enrich the paginated slice with China-agent IT state so the list can flag
  // POs to the buying agent that are missing their Inventory Transfer. One raw
  // query keyed by these ids — does not affect pagination/counts.
  const typedRows = rows as unknown as Array<{
    id: string;
    status: string;
    total_units_received?: number | null;
    vendor_id: string;
  }>;
  let purchase_orders: unknown[] = rows;
  try {
    const knex = (req.scope as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }).resolve("__pg_connection__");
    const ctMap = await enrichChinaTransferMap(knex, typedRows);
    let billedMap: Map<string, { billed_status: string; billed_qty: number }> = new Map();
    try {
      billedMap = await enrichBilledStatusMap(knex, typedRows);
    } catch {
      // Non-fatal: fall back to no billed_status decoration.
    }
    // Tracking lives in its own tables since the deliveries migration; the
    // `tracking` jsonb column on the model is a frozen pre-migration snapshot
    // that no writer maintains. Hydrating here is what stops the list from
    // contradicting the PO's own page. See _lib/tracking-summary.ts.
    let trackingMap: Map<string, TrackingSummary> = new Map();
    try {
      trackingMap = await enrichTrackingSummaryMap(knex, typedRows);
    } catch {
      // Non-fatal: fall back to no tracking decoration.
    }
    purchase_orders = typedRows.map((r) => ({
      ...r,
      china_transfer: ctMap.get(r.id) ?? null,
      billed_status: billedMap.get(r.id)?.billed_status ?? "no",
      billed_qty: billedMap.get(r.id)?.billed_qty ?? 0,
      tracking_summary: trackingMap.get(r.id) ?? null,
    }));
  } catch {
    // Non-fatal: fall back to raw rows without china_transfer decoration.
  }

  return res.json({
    purchase_orders,
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

  const service = getPurchaseOrdersService(req);

  const normalized = body.lines.map(normalizeLine);
  const totals = computeTotals(normalized, {
    shipping_cents: body.shipping_cents,
    tax_cents: body.tax_cents,
    other_fees_cents: body.other_fees_cents,
  });

  // Snapshot vendor name at creation so drafts display the name before submit.
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

  // Fallback: direct DB lookup when QB catalog service returns nothing
  if (!vendorRow) {
    const knex = (req.scope as any).resolve("__pg_connection__");
    const rows = await knex.raw(
      `SELECT qb_list_id, full_name, name, company_name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [body.vendor_id]
    ).then((r: any) => r.rows);
    if (rows.length > 0) vendorRow = rows[0];
  }

  const vendorNameSnapshot = vendorRow
    ? resolveVendorDisplayName(vendorRow)
    : null;
  const vendorQbListIdSnapshot = vendorRow?.qb_list_id ?? null;

  // Drafts get a throwaway D-{n} label from a separate sequence.
  // The real PO-{n} is assigned only when the draft is submitted (approved),
  // so exploratory or AI-generated drafts never consume real PO numbers.
  const draftSeq = await service.getNextDraftSequence();
  const number = `D-${draftSeq}`;

  const [po] = await service.createPurchaseOrders([
    {
      status: "draft",
      number,
      draft_number: number,
      seq: null,
      vendor_id: body.vendor_id,
      vendor_name_snapshot: vendorNameSnapshot,
      vendor_qb_list_id_snapshot: vendorQbListIdSnapshot,
      stock_location_id: body.stock_location_id?.trim() ?? body.stock_location_id,
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
