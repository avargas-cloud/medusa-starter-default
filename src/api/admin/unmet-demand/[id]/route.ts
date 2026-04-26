/**
 * src/api/admin/unmet-demand/[id]/route.ts
 *
 * GET    /admin/unmet-demand/:id  — record + items (split by kind)
 * PATCH  /admin/unmet-demand/:id  — update record + replace items, snapshot totals
 * DELETE /admin/unmet-demand/:id  — soft-delete (cascades to items via FK)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { enrichRecord } from "../_lib/enrich-record";
import { zodErrorToBody } from "../_lib/format";
import { getUnmetDemandService } from "../_lib/service-resolver";
import { computeTotals, normalizeItem } from "../_lib/totals";
import { updateRecordSchema } from "../_lib/validators";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const service = getUnmetDemandService(req);

  const record = (await service
    .retrieveUnmetDemandRecord(id)
    .catch(() => null)) as Record<string, unknown> | null;
  if (!record) {
    return res
      .status(404)
      .json({ error: "Record not found", code: "not_found" });
  }

  const items = (await service.listUnmetDemandItems(
    { record_id: id },
    { take: 1000, skip: 0, order: { created_at: "ASC" } }
  )) as Array<Record<string, unknown> & { kind: "requested" | "purchased" }>;

  const requested = items.filter((i) => i.kind === "requested");
  const purchased = items.filter((i) => i.kind === "purchased");

  const enrichment = await enrichRecord(req, service, record);

  return res.json({
    unmet_demand: {
      ...record,
      requested,
      purchased,
      ...enrichment,
    },
  });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = updateRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getUnmetDemandService(req);

  const existing = (await service
    .retrieveUnmetDemandRecord(id)
    .catch(() => null)) as Record<string, unknown> | null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Record not found", code: "not_found" });
  }

  // Header patch
  const headerUpdate: Record<string, unknown> = { id };
  if (body.customer_id !== undefined)
    headerUpdate.customer_id = body.customer_id;
  if (body.price_tier !== undefined) headerUpdate.price_tier = body.price_tier;
  if (body.notes !== undefined) headerUpdate.notes = body.notes ?? null;

  // If items provided → HARD-replace all items + recompute totals.
  // Hard delete (not soft) so a modified record is the single source of
  // truth — no historical versions linger in the DB.
  if (body.items !== undefined) {
    const oldItems = (await service.listUnmetDemandItems(
      { record_id: id },
      { take: 1000, skip: 0 }
    )) as Array<{ id: string }>;
    if (oldItems.length > 0) {
      await service.hardDeleteUnmetDemandItems(oldItems.map((i) => i.id));
    }

    const normalized = body.items.map(normalizeItem);
    const totals = computeTotals(normalized);

    if (normalized.length > 0) {
      await service.createUnmetDemandItems(
        normalized.map((it) => ({
          record_id: id,
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

    headerUpdate.requested_total_cents = totals.requested_total_cents;
    headerUpdate.purchased_total_cents = totals.purchased_total_cents;
    headerUpdate.unmet_value_cents = totals.unmet_value_cents;
  }

  const [updated] = await service.updateUnmetDemandRecords([headerUpdate]);

  // Mirror GET detail shape — enrich with customer labels + neighbors + items
  // so the client can drop the invalidate-and-refetch round-trip after save.
  const updatedRecord = updated as unknown as Record<string, unknown>;
  const freshItems = (await service.listUnmetDemandItems(
    { record_id: id },
    { take: 1000, skip: 0, order: { created_at: "ASC" } }
  )) as Array<Record<string, unknown> & { kind: "requested" | "purchased" }>;
  const requested = freshItems.filter((i) => i.kind === "requested");
  const purchased = freshItems.filter((i) => i.kind === "purchased");
  const enrichment = await enrichRecord(req, service, updatedRecord);

  return res.json({
    unmet_demand: {
      ...updatedRecord,
      requested,
      purchased,
      ...enrichment,
    },
  });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getUnmetDemandService(req);

  const existing = (await service
    .retrieveUnmetDemandRecord(id)
    .catch(() => null)) as Record<string, unknown> | null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Record not found", code: "not_found" });
  }

  // Hard-delete items first (required because of the FK), then the header.
  // No soft-delete: voiding a record wipes it entirely so there's a single
  // source of truth — the UI never shows ghost rows and the DB stays clean.
  const items = (await service.listUnmetDemandItems(
    { record_id: id },
    { take: 1000, skip: 0 }
  )) as Array<{ id: string }>;
  if (items.length > 0) {
    await service.hardDeleteUnmetDemandItems(items.map((i) => i.id));
  }

  await service.hardDeleteUnmetDemandRecord(id);

  return res.status(204).end();
}
