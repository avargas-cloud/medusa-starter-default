/**
 * src/api/admin/unmet-demand/route.ts
 *
 * GET  /admin/unmet-demand  — paginated list with filters
 * POST /admin/unmet-demand  — create record + items (totals snapshotted)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "./_lib/auth";
import { formatUnmetDemandNumber, zodErrorToBody } from "./_lib/format";
import { getUnmetDemandService } from "./_lib/service-resolver";
import { computeTotals, normalizeItem } from "./_lib/totals";
import { createRecordSchema, listQuerySchema } from "./_lib/validators";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const q = parsed.data;

  const service = getUnmetDemandService(req);

  const where: Record<string, unknown> = {};
  if (q.customer_id) where.customer_id = q.customer_id;
  if (q.created_by_user_id) where.created_by_user_id = q.created_by_user_id;

  const created_at: Record<string, Date> = {};
  if (q.from) created_at.$gte = new Date(q.from);
  if (q.to) created_at.$lte = new Date(q.to);
  if (Object.keys(created_at).length > 0) where.created_at = created_at;

  const unmet: Record<string, number> = {};
  if (q.min_unmet_value_cents !== undefined)
    unmet.$gte = q.min_unmet_value_cents;
  if (q.max_unmet_value_cents !== undefined)
    unmet.$lte = q.max_unmet_value_cents;
  if (Object.keys(unmet).length > 0) where.unmet_value_cents = unmet;

  // SKU filter → find records containing at least one item matching the SKU
  if (q.sku) {
    const itemWhere: Record<string, unknown> = {
      sku: { $ilike: `%${q.sku}%` },
    };
    if (q.kind) itemWhere.kind = q.kind;
    const matchingItems = await service.listUnmetDemandItems(itemWhere, {
      take: 1000,
      skip: 0,
    });
    const recordIds = Array.from(
      new Set(
        (matchingItems as Array<{ record_id: string }>).map((i) => i.record_id)
      )
    );
    if (recordIds.length === 0) {
      return res.json({
        unmet_demands: [],
        count: 0,
        limit: q.limit,
        offset: q.offset,
      });
    }
    where.id = recordIds;
  }

  const [rows, count] = await service.listAndCountUnmetDemandRecords(where, {
    take: q.limit,
    skip: q.offset,
    order: { created_at: "DESC" },
  });

  // Attach item counts per record (cheap: one list call filtered by ids)
  const ids = (rows as Array<{ id: string }>).map((r) => r.id);
  const items =
    ids.length > 0
      ? ((await service.listUnmetDemandItems(
          { record_id: ids },
          { take: 20000, skip: 0 }
        )) as Array<{
          record_id: string;
          kind: "requested" | "purchased";
        }>)
      : [];

  const byRecord = new Map<
    string,
    { requested: number; purchased: number }
  >();
  for (const it of items) {
    const b = byRecord.get(it.record_id) ?? { requested: 0, purchased: 0 };
    if (it.kind === "requested") b.requested += 1;
    else b.purchased += 1;
    byRecord.set(it.record_id, b);
  }

  // Resolve customer_name + customer_company for each row in a single batch
  // so the list page can show human-readable labels instead of raw IDs.
  const customerIds = Array.from(
    new Set(
      (rows as Array<{ customer_id?: string | null }>)
        .map((r) => r.customer_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  const customerById = new Map<
    string,
    { first_name?: string | null; last_name?: string | null; email?: string | null; company_name?: string | null }
  >();
  if (customerIds.length > 0) {
    try {
      const customerService = req.scope.resolve(Modules.CUSTOMER) as unknown as {
        listCustomers: (
          filter: Record<string, unknown>,
          config?: Record<string, unknown>
        ) => Promise<
          Array<{
            id: string;
            first_name?: string | null;
            last_name?: string | null;
            email?: string | null;
            company_name?: string | null;
          }>
        >;
      };
      const customers = await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length }
      );
      for (const c of customers) {
        customerById.set(c.id, {
          first_name: c.first_name ?? null,
          last_name: c.last_name ?? null,
          email: c.email ?? null,
          company_name: c.company_name ?? null,
        });
      }
    } catch (err) {
      // Don't break the list if customer lookup fails — surface as "—" in UI
      console.error("[unmet-demand list] customer lookup failed:", err);
    }
  }

  const decorated = (rows as Array<Record<string, unknown>>).map((r) => {
    const cid = r.customer_id as string | null;
    const c = cid ? customerById.get(cid) : undefined;
    const fullName = c
      ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
        c.company_name ||
        c.email ||
        null
      : null;
    return {
      ...r,
      requested_item_count: byRecord.get(r.id as string)?.requested ?? 0,
      purchased_item_count: byRecord.get(r.id as string)?.purchased ?? 0,
      customer_name: fullName,
      customer_email: c?.email ?? null,
      customer_company: c?.company_name ?? null,
    };
  });

  return res.json({
    unmet_demands: decorated,
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

  const parsed = createRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getUnmetDemandService(req);

  const normalized = body.items.map(normalizeItem);
  const totals = computeTotals(normalized);

  // Allocate canonical UMD-{seq} at creation (matches the convention of
  // estimates / invoices / inventory counts).
  const seq = await service.getNextSequence();
  const number = formatUnmetDemandNumber(seq);
  const year = new Date().getFullYear();

  const [record] = await service.createUnmetDemandRecords([
    {
      number,
      seq,
      year,
      customer_id: body.customer_id,
      created_by_user_id: userId,
      price_tier: body.price_tier,
      notes: body.notes ?? null,
      requested_total_cents: totals.requested_total_cents,
      purchased_total_cents: totals.purchased_total_cents,
      unmet_value_cents: totals.unmet_value_cents,
    },
  ]);

  if (!record) {
    return res
      .status(500)
      .json({ error: "Failed to create record", code: "create_failed" });
  }

  if (normalized.length > 0) {
    await service.createUnmetDemandItems(
      normalized.map((it) => ({
        record_id: record.id,
        kind: it.kind,
        product_id: it.product_id ?? null,
        variant_id: it.variant_id ?? null,
        sku: it.sku,
        title: it.title,
        thumbnail: it.thumbnail ?? null,
        sales_description: it.sales_description ?? null,
        quantity: it.quantity,
        unit_price_cents: it.unit_price_cents,
        subtotal_cents: it.subtotal_cents,
      }))
    );
  }

  return res.status(201).json({ unmet_demand: record });
}
