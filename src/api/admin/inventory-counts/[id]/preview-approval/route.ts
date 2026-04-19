/**
 * src/api/admin/inventory-counts/[id]/preview-approval/route.ts
 *
 * GET /admin/inventory-counts/:id/preview-approval (manager-only)
 *
 * Returns each submitted line annotated with current_stock_now and
 * projected_stock so the manager UI can flag lines that would block
 * before they hit Approve.
 */

import { Modules } from "@medusajs/utils";
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  ManagerRoleRequiredError,
  UnauthenticatedError,
  requireManager,
} from "../../_lib/auth";
import { getInventoryCountService } from "../../_lib/service-resolver";
import type { PreviewApprovalLine } from "../../_lib/types";

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await requireManager(req);
  } catch (err) {
    if (
      err instanceof ManagerRoleRequiredError ||
      err instanceof UnauthenticatedError
    ) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "submitted" && count.status !== "partially_applied") {
    return res.status(409).json({
      error: `Preview only available for submitted counts (current status: ${count.status})`,
      code: "not_submitted",
    });
  }

  const lines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000, order: { sku: "ASC" } }
  );

  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike;

  const itemIds = Array.from(new Set(lines.map((l) => l.inventory_item_id)));
  const levels = await inventoryService.listInventoryLevels(
    {
      inventory_item_id: itemIds,
      location_id: count.stock_location_id,
    },
    { take: 5000 }
  );
  const stockByItem = new Map<string, number>();
  for (const lvl of levels) {
    stockByItem.set(lvl.inventory_item_id, lvl.stocked_quantity ?? 0);
  }

  const previewLines: PreviewApprovalLine[] = lines.map((l) => {
    const current = stockByItem.get(l.inventory_item_id) ?? 0;
    const delta = l.delta_original ?? 0;
    const projected = current + delta;
    const willBlock = projected < 0;
    return {
      line_id: l.id,
      sku: l.sku,
      product_title: l.product_title,
      qty_at_count_time: l.qty_at_count_time ?? 0,
      qty_counted: l.qty_counted ?? 0,
      delta_original: delta,
      current_stock_now: current,
      projected_stock: projected,
      will_block: willBlock,
      block_reason: willBlock ? "projected_negative" : null,
      qb_account_list_id:
        l.qb_account_list_id ?? count.default_qb_account_list_id,
    };
  });

  const summary = {
    total_lines: previewLines.length,
    will_apply: previewLines.filter((l) => !l.will_block).length,
    will_block: previewLines.filter((l) => l.will_block).length,
    total_delta_units_apply: previewLines
      .filter((l) => !l.will_block)
      .reduce((acc, l) => acc + Math.abs(l.delta_original), 0),
  };

  return res.json({
    inventory_count: count,
    lines: previewLines,
    summary,
  });
}
