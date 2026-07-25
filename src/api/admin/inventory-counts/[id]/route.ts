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
import { Modules } from "@medusajs/utils";

import {
  buildEnrichmentMaps,
  buildSalesDescriptionMap,
  decorateCount,
} from "../_lib/enrich";
import { zodErrorToBody } from "../_lib/format";
import { getInventoryCountService } from "../_lib/service-resolver";
import type { UpdateDraftLineInput } from "../_lib/types";
import { updateDraftSchema } from "../_lib/validators";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }

  const lines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000, order: { sku: "ASC" } }
  );

  const [maps, salesDescByVariant] = await Promise.all([
    buildEnrichmentMaps(req, [count]),
    buildSalesDescriptionMap(
      req,
      lines.map((l) => l.product_variant_id)
    ),
  ]);
  const enriched = decorateCount(count, maps);

  const linesWithDesc = lines.map((l) => ({
    ...l,
    product_sales_description:
      salesDescByVariant.get(l.product_variant_id) ?? null,
  }));

  return res.json({ inventory_count: enriched, lines: linesWithDesc });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest<{
    lines?: UpdateDraftLineInput[];
    memo?: string;
  }>,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
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
    return res.json({
      inventory_count_id: id,
      lines: [],
      created: 0,
      updated: 0,
    });
  }

  const existing = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000 }
  );

  const existingByVariant = new Map(
    existing.map((l) => [l.product_variant_id, l])
  );

  // Live stocked snapshot for staleness detection (Phase 2). When a line's count
  // changes we freeze the stocked_quantity it was counted against; the DB trigger
  // later flags needs_recount if that stock moves while the draft is still open.
  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as unknown as {
    listInventoryLevels: (
      filters: Record<string, unknown>,
      options?: { take?: number }
    ) => Promise<
      Array<{
        inventory_item_id: string;
        stocked_quantity: number;
        reserved_quantity: number;
      }>
    >;
  };
  const incomingItemIds = Array.from(
    new Set(incoming.map((l) => l.inventory_item_id))
  );
  const levels = incomingItemIds.length
    ? await inventoryService.listInventoryLevels(
        {
          inventory_item_id: incomingItemIds,
          location_id: count.stock_location_id,
        },
        { take: 5000 }
      )
    : [];
  const stockedByItem = new Map<string, number>();
  const reservedByItem = new Map<string, number>();
  for (const lvl of levels) {
    stockedByItem.set(lvl.inventory_item_id, lvl.stocked_quantity ?? 0);
    reservedByItem.set(lvl.inventory_item_id, lvl.reserved_quantity ?? 0);
  }

  const toCreate: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];

  for (const inLine of incoming) {
    // Total is derived from the two components; an unset on_hand means the line
    // is still uncounted (qty_counted stays null → dropped at submit).
    const onHand = inLine.qty_counted_available;
    const reserved = inLine.qty_counted_reserved;
    const qtyCounted = onHand === null ? null : onHand + (reserved ?? 0);
    const found = existingByVariant.get(inLine.product_variant_id);

    // Did the counted total change on this save? Re-snapshot the baseline and
    // clear any prior stale flag; uncounting clears the snapshot entirely.
    const countChanged = !found || found.qty_counted !== qtyCounted;
    let staleness: Record<string, unknown> = {};
    if (countChanged) {
      if (qtyCounted === null) {
        staleness = {
          counted_at: null,
          stocked_at_count: null,
          reserved_at_count_time: null,
          needs_recount: false,
          stock_moved_at: null,
          stocked_after_movement: null,
        };
      } else {
        staleness = {
          counted_at: new Date(),
          stocked_at_count: stockedByItem.get(inLine.inventory_item_id) ?? null,
          reserved_at_count_time:
            reservedByItem.get(inLine.inventory_item_id) ?? null,
          needs_recount: false,
          stock_moved_at: null,
          stocked_after_movement: null,
        };
      }
    }

    if (found) {
      toUpdate.push({
        id: found.id,
        sku: inLine.sku,
        product_title: inLine.product_title,
        inventory_item_id: inLine.inventory_item_id,
        qty_counted: qtyCounted,
        qty_counted_available: onHand,
        qty_counted_reserved: reserved,
        qb_account_list_id: inLine.qb_account_list_id ?? null,
        ...staleness,
      });
    } else {
      toCreate.push({
        inventory_count_id: id,
        product_variant_id: inLine.product_variant_id,
        inventory_item_id: inLine.inventory_item_id,
        sku: inLine.sku,
        product_title: inLine.product_title,
        qty_counted: qtyCounted,
        qty_counted_available: onHand,
        qty_counted_reserved: reserved,
        qb_account_list_id: inLine.qb_account_list_id ?? null,
        status: "pending",
        ...staleness,
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
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts may be cancelled (current status: ${count.status})`,
      code: "not_draft",
    });
  }

  const lines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 1 }
  );
  if (lines.length === 0) {
    await service.deleteInventoryCounts([id]);
    return res.json({ id, deleted: true });
  }

  await service.updateInventoryCounts([{ id, status: "cancelled" }]);

  return res.json({ id, cancelled: true });
}
