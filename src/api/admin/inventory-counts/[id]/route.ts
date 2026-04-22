/**
 * src/api/admin/inventory-counts/[id]/route.ts
 *
 * GET    /admin/inventory-counts/:id   — detail with all lines
 * PATCH  /admin/inventory-counts/:id   — upsert draft lines (autosave from cashier)
 * DELETE /admin/inventory-counts/:id   — cancel a draft (only drafts may be cancelled)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { buildEnrichmentMaps, decorateCount } from "../_lib/enrich";
import { zodErrorToBody } from "../_lib/format";
import { getInventoryCountService } from "../_lib/service-resolver";
import { updateDraftSchema } from "../_lib/validators";
import type { UpdateDraftLineInput } from "../_lib/types";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({ error: "inventory_count not found", code: "not_found" });
  }

  const lines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000, order: { sku: "ASC" } }
  );

  const maps = await buildEnrichmentMaps(req, [count]);
  const enriched = decorateCount(count, maps);

  return res.json({ inventory_count: enriched, lines });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest<{ lines?: UpdateDraftLineInput[]; memo?: string }>,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Cannot edit lines on a ${count.status} count`,
      code: "not_draft",
    });
  }

  const parsed = updateDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { lines: incoming, memo } = parsed.data;

  // Memo-only update — skip all line processing
  if (incoming === undefined) {
    if (memo !== undefined) {
      await service.updateInventoryCounts([{ id, memo }]);
    }
    return res.json({ inventory_count_id: id, lines: [], created: 0, updated: 0 });
  }

  const existing = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000 }
  );

  const existingByVariant = new Map(
    existing.map((l) => [l.product_variant_id, l])
  );

  const toCreate: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];

  for (const inLine of incoming) {
    const found = existingByVariant.get(inLine.product_variant_id);
    if (found) {
      toUpdate.push({
        id: found.id,
        sku: inLine.sku,
        product_title: inLine.product_title,
        inventory_item_id: inLine.inventory_item_id,
        qty_counted: inLine.qty_counted,
        qb_account_list_id: inLine.qb_account_list_id ?? null,
      });
    } else {
      toCreate.push({
        inventory_count_id: id,
        product_variant_id: inLine.product_variant_id,
        inventory_item_id: inLine.inventory_item_id,
        sku: inLine.sku,
        product_title: inLine.product_title,
        qty_counted: inLine.qty_counted,
        qb_account_list_id: inLine.qb_account_list_id ?? null,
        status: "pending",
      });
    }
  }

  if (toCreate.length) await service.createInventoryCountLines(toCreate);
  if (toUpdate.length) await service.updateInventoryCountLines(toUpdate);

  const countUpdate: Record<string, unknown> = {
    id,
    total_lines: existing.length + toCreate.length,
  };
  if (memo !== undefined) countUpdate.memo = memo;

  await service.updateInventoryCounts([countUpdate]);

  const refreshed = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000, order: { sku: "ASC" } }
  );

  return res.json({
    inventory_count_id: id,
    lines: refreshed,
    created: toCreate.length,
    updated: toUpdate.length,
  });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts may be cancelled (current status: ${count.status})`,
      code: "not_draft",
    });
  }

  await service.updateInventoryCounts([{ id, status: "cancelled" }]);

  return res.json({ id, cancelled: true });
}
