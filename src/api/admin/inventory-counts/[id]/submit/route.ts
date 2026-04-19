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

import { Modules } from "@medusajs/utils";
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { zodErrorToBody } from "../../_lib/format";
import { getInventoryCountService } from "../../_lib/service-resolver";
import { submitSchema } from "../../_lib/validators";

interface InventoryService {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
    reserved_quantity: number;
  }>>;
}

export async function POST(
  req: AuthenticatedMedusaRequest<{ memo: string }>,
  res: MedusaResponse
) {
  const { id } = req.params;
  const service = getInventoryCountService(req);

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { memo } = parsed.data;

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({ error: "inventory_count not found", code: "not_found" });
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
  const inventoryService = req.scope.resolve(Modules.INVENTORY) as InventoryService;
  const inventoryItemIds = Array.from(new Set(lines.map((l) => l.inventory_item_id)));

  const levels = await inventoryService.listInventoryLevels(
    {
      inventory_item_id: inventoryItemIds,
      location_id: count.stock_location_id,
    },
    { take: 5000 }
  );

  const stockByItem = new Map<string, number>();
  for (const lvl of levels) {
    stockByItem.set(lvl.inventory_item_id, lvl.stocked_quantity ?? 0);
  }

  // 2. Compute delta_original per line; freeze qty_at_count_time.
  //    Uncounted lines (qty_counted === null) → delta=0, no adjustment.
  const lineUpdates: Array<Record<string, unknown>> = [];
  let totalDeltaUnits = 0;
  for (const line of lines) {
    const stockAtCount = stockByItem.get(line.inventory_item_id) ?? 0;
    const isUncounted =
      line.qty_counted === null || line.qty_counted === undefined;
    const delta = isUncounted ? 0 : (line.qty_counted as number) - stockAtCount;
    totalDeltaUnits += Math.abs(delta);
    lineUpdates.push({
      id: line.id,
      qty_at_count_time: stockAtCount,
      delta_original: delta,
      status: "pending",
    });
  }
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
}
