/**
 * src/api/admin/inventory-counts/[id]/submit/route.ts
 *
 * POST /admin/inventory-counts/:id/submit
 *
 * Atomically:
 *   1. Allocates a new annual sequence number (INVCNT-2026-001)
 *   2. Snapshots qty_at_count_time for every line from the live inventory_level
 *   3. Computes delta_original = qty_counted - qty_at_count_time
 *   4. Sets header status = 'submitted', records memo + submitted_at
 *
 * After submit the count is read-only for the cashier; only manager
 * approve/reject can move it forward.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { Knex } from "knex";

import {
  acquireItemClaims,
  describeClaimConflicts,
  releaseClaimsForCount,
} from "../../../../../lib/inventory-count/item-claims";
import {
  buildInventoryCountStockBaseline,
  calculateInventoryCountDelta,
} from "../../../../../lib/inventory-count/stock-baseline";
import { zodErrorToBody } from "../../_lib/format";
import { getInventoryCountService } from "../../_lib/service-resolver";
import { submitSchema } from "../../_lib/validators";

interface InventoryService {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<
    Array<{
      inventory_item_id: string;
      location_id: string;
      stocked_quantity: number;
      reserved_quantity: number;
    }>
  >;
}

export async function POST(
  req: AuthenticatedMedusaRequest<{ memo: string }>,
  res: MedusaResponse
) {
  const id = req.params.id as string;
  const service = getInventoryCountService(req);

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { memo } = parsed.data;

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts may be submitted (current status: ${count.status})`,
      code: "not_draft",
    });
  }

  const allLines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000 }
  );
  if (allLines.length === 0) {
    return res.status(400).json({
      error: "Cannot submit a count with zero lines",
      code: "no_lines",
    });
  }

  // Drop uncounted lines: an empty input means the cashier did not verify
  // that SKU. Only counted lines (including explicit 0) carry forward —
  // they represent actual counting work and form the audit trail.
  const uncounted = allLines.filter(
    (l) => l.qty_counted === null || l.qty_counted === undefined
  );
  const lines = allLines.filter(
    (l) => l.qty_counted !== null && l.qty_counted !== undefined
  );

  if (lines.length === 0) {
    return res.status(400).json({
      error: "All lines are uncounted; nothing to submit",
      code: "all_uncounted",
    });
  }

  if (uncounted.length > 0) {
    await service.deleteInventoryCountLines(uncounted.map((l) => l.id));
  }

  // 1. Snapshot live stock for each line (for the configured location)
  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as InventoryService;
  const inventoryItemIds = Array.from(
    new Set(lines.map((l) => l.inventory_item_id))
  );

  const levels = await inventoryService.listInventoryLevels(
    {
      inventory_item_id: inventoryItemIds,
      location_id: count.stock_location_id,
    },
    { take: 5000 }
  );

  const stockByItem = new Map<string, number>();
  const reservedByItem = new Map<string, number>();
  for (const lvl of levels) {
    stockByItem.set(lvl.inventory_item_id, lvl.stocked_quantity ?? 0);
    reservedByItem.set(lvl.inventory_item_id, lvl.reserved_quantity ?? 0);
  }

  // Guard: whenever the system holds reserved (apartados) units for an item,
  // the clerk MUST have counted that shelf — leaving qty_counted_reserved null
  // silently undercounts and drives the delta negative (the INVCNT-1059 bug).
  const missingReserved = lines.filter((l) => {
    const baseline = buildInventoryCountStockBaseline(
      stockByItem.get(l.inventory_item_id) ?? 0,
      reservedByItem.get(l.inventory_item_id) ?? 0
    );
    return (
      baseline.effectiveReserved > 0 &&
      (l.qty_counted_reserved === null || l.qty_counted_reserved === undefined)
    );
  });
  if (missingReserved.length > 0) {
    return res.status(400).json({
      error:
        "Some lines have reserved (apartados) units but the reserved count " +
        "was left empty. Count the reserved/holding area for these SKUs " +
        "before submitting.",
      code: "reserved_count_required",
      skus: missingReserved.map((l) => l.sku),
    });
  }

  // Guard both physical baselines. A reservation movement can change which rack
  // must be counted even when total on-hand stays unchanged.
  const staleLines = lines.filter((l) => {
    const liveStock = stockByItem.get(l.inventory_item_id) ?? 0;
    const liveBaseline = buildInventoryCountStockBaseline(
      liveStock,
      reservedByItem.get(l.inventory_item_id) ?? 0
    );
    const snapshottedEffectiveReserved =
      l.effective_reserved_at_count_time ??
      (l.stocked_at_count !== null &&
      l.stocked_at_count !== undefined &&
      l.reserved_at_count_time !== null &&
      l.reserved_at_count_time !== undefined
        ? buildInventoryCountStockBaseline(
            l.stocked_at_count,
            l.reserved_at_count_time
          ).effectiveReserved
        : null);

    return (
      l.needs_recount === true ||
      (l.stocked_at_count !== null &&
        l.stocked_at_count !== undefined &&
        l.stocked_at_count !== liveStock) ||
      (snapshottedEffectiveReserved !== null &&
        snapshottedEffectiveReserved !== liveBaseline.effectiveReserved)
    );
  });
  if (staleLines.length > 0) {
    return res.status(400).json({
      error:
        "Stock or reserved allocation moved for some counted lines after they " +
        "were counted. Re-count these SKUs before submitting.",
      code: "recount_required",
      skus: staleLines.map((l) => l.sku),
    });
  }

  // Item exclusivity. Submit is the moment the delta stops being an observation
  // and becomes an armed correction, so it is the moment the item gets claimed.
  //
  // Without this, two counts covering the same SKU each freeze the WHOLE
  // discrepancy and each applies it in full: stock lands double-corrected and
  // QuickBooks books the same shrinkage twice. The live-stock comparison above
  // cannot see it — both counts snapshot the same correct number.
  //
  // Runs after the cheap validations so a count that would fail them anyway
  // does not leave claims behind, and before any write so a rejected submit
  // changes nothing.
  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as Knex;

  const claimConflicts = await acquireItemClaims(knex, {
    inventoryCountId: id,
    stockLocationId: count.stock_location_id,
    candidates: lines.map((l) => ({
      inventory_item_id: l.inventory_item_id,
      inventory_count_line_id: l.id,
      sku: l.sku,
    })),
  });

  if (claimConflicts.length > 0) {
    return res.status(409).json({
      error: describeClaimConflicts(claimConflicts),
      code: "item_claimed_by_other_count",
      conflicts: claimConflicts.map((c) => ({
        sku: c.sku,
        inventory_item_id: c.inventory_item_id,
        inventory_count_id: c.inventory_count_id,
        inventory_count_number: c.inventory_count_number,
        inventory_count_status: c.inventory_count_status,
      })),
    });
  }

  // 2. Compute delta_original per line; freeze qty_at_count_time.
  //    Uncounted lines (qty_counted === null) → delta=0, no adjustment.
  const lineUpdates: Array<Record<string, unknown>> = [];
  let totalDeltaUnits = 0;
  for (const line of lines) {
    const stockAtCount = stockByItem.get(line.inventory_item_id) ?? 0;
    const rawReservedAtCount = reservedByItem.get(line.inventory_item_id) ?? 0;
    const baseline = buildInventoryCountStockBaseline(
      stockAtCount,
      rawReservedAtCount
    );
    const isUncounted =
      line.qty_counted === null || line.qty_counted === undefined;
    const deltaResult = isUncounted
      ? null
      : calculateInventoryCountDelta({
          onHand: stockAtCount,
          rawReserved: rawReservedAtCount,
          countedAvailable: line.qty_counted_available ?? 0,
          countedReserved: line.qty_counted_reserved ?? 0,
        });
    const delta = deltaResult?.delta ?? 0;
    totalDeltaUnits += Math.abs(delta);
    lineUpdates.push({
      id: line.id,
      qty_at_count_time: stockAtCount,
      reserved_at_count_time: rawReservedAtCount,
      effective_reserved_at_count_time: baseline.effectiveReserved,
      delta_original: delta,
      status: "pending",
    });
  }
  // The claims are already held at this point, but the module-service writes
  // below are not part of that transaction. If any of them fails the count
  // stays a draft, so leaving the claims behind would lock those SKUs against a
  // count that never became armed. Release them and let the error surface.
  try {
    await service.updateInventoryCountLines(lineUpdates);

    // 3. Promote header to submitted (number/seq were assigned at creation)
    const [updated] = await service.updateInventoryCounts([
      {
        id,
        status: "submitted",
        memo,
        submitted_at: new Date(),
        total_lines: lines.length,
        total_delta_units: totalDeltaUnits,
      },
    ]);

    return res.json({ inventory_count: updated });
  } catch (err) {
    await releaseClaimsForCount(knex, id);
    throw err;
  }
}
