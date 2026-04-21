/**
 * src/api/admin/unmet-demand/item-stats/route.ts
 *
 * GET /admin/unmet-demand/item-stats
 *   ?sku=SKU-A               (optional — filter single SKU; comma-separated for multiple)
 *   &variant_id=variant_xxx  (optional — alternative to sku)
 *   &from=ISO &to=ISO        (optional — bounded by record created_at)
 *   &kind=requested|purchased (optional — filter kind)
 *   &limit=50 &offset=0
 *
 * Aggregates unmet_demand_item rows across records. Used to answer
 * "how many units of SKU-A were requested but not purchased in the
 * last 30 days?" — drives restocking decisions.
 *
 * Returned rows:
 *   [
 *     {
 *       sku, variant_id, title,
 *       requested_quantity, purchased_quantity,
 *       net_shortage,                 // requested - purchased (positive = under-fulfilled)
 *       requested_record_count,
 *       purchased_record_count,
 *     },
 *     ...
 *   ]
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../_lib/format";
import { getUnmetDemandService } from "../_lib/service-resolver";
import { UNMET_DEMAND_ITEM_KINDS } from "../../../../modules/unmet-demand/types";

const querySchema = z.object({
  sku: z.string().min(1).optional(),
  variant_id: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  kind: z.enum(UNMET_DEMAND_ITEM_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

interface StatRow {
  sku: string;
  variant_id: string | null;
  title: string;
  requested_quantity: number;
  purchased_quantity: number;
  net_shortage: number;
  requested_record_count: number;
  purchased_record_count: number;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const q = parsed.data;

  const service = getUnmetDemandService(req);

  // If date filter present, first find records in range, then limit items by record_id
  let recordIdFilter: string[] | undefined;
  if (q.from || q.to) {
    const created_at: Record<string, Date> = {};
    if (q.from) created_at.$gte = new Date(q.from);
    if (q.to) created_at.$lte = new Date(q.to);
    const records = (await service.listUnmetDemandRecords(
      { created_at },
      { take: 100000, skip: 0 }
    )) as Array<{ id: string }>;
    recordIdFilter = records.map((r) => r.id);
    if (recordIdFilter.length === 0) {
      return res.json({ items: [], count: 0, limit: q.limit, offset: q.offset });
    }
  }

  const itemWhere: Record<string, unknown> = {};
  if (q.sku) {
    const skus = q.sku.split(",").map((s) => s.trim()).filter(Boolean);
    itemWhere.sku = skus.length === 1 ? skus[0] : skus;
  }
  if (q.variant_id) itemWhere.variant_id = q.variant_id;
  if (q.kind) itemWhere.kind = q.kind;
  if (recordIdFilter) itemWhere.record_id = recordIdFilter;

  const items = (await service.listUnmetDemandItems(itemWhere, {
    take: 100000,
    skip: 0,
  })) as Array<{
    sku: string;
    variant_id: string | null;
    title: string;
    kind: "requested" | "purchased";
    quantity: number;
    record_id: string;
  }>;

  // Aggregate by sku (primary key) — variant_id/title taken from first row seen
  const byKey = new Map<string, StatRow & {
    _recRequested: Set<string>;
    _recPurchased: Set<string>;
  }>();

  for (const it of items) {
    const key = it.sku;
    let row = byKey.get(key);
    if (!row) {
      row = {
        sku: it.sku,
        variant_id: it.variant_id,
        title: it.title,
        requested_quantity: 0,
        purchased_quantity: 0,
        net_shortage: 0,
        requested_record_count: 0,
        purchased_record_count: 0,
        _recRequested: new Set<string>(),
        _recPurchased: new Set<string>(),
      };
      byKey.set(key, row);
    }

    if (it.kind === "requested") {
      row.requested_quantity += it.quantity;
      row._recRequested.add(it.record_id);
    } else {
      row.purchased_quantity += it.quantity;
      row._recPurchased.add(it.record_id);
    }
  }

  const rows: StatRow[] = Array.from(byKey.values()).map((r) => ({
    sku: r.sku,
    variant_id: r.variant_id,
    title: r.title,
    requested_quantity: r.requested_quantity,
    purchased_quantity: r.purchased_quantity,
    net_shortage: r.requested_quantity - r.purchased_quantity,
    requested_record_count: r._recRequested.size,
    purchased_record_count: r._recPurchased.size,
  }));

  // Sort by net_shortage desc (biggest gaps first) — most useful for reordering
  rows.sort((a, b) => b.net_shortage - a.net_shortage);

  const paged = rows.slice(q.offset, q.offset + q.limit);

  return res.json({
    items: paged,
    count: rows.length,
    limit: q.limit,
    offset: q.offset,
  });
}
