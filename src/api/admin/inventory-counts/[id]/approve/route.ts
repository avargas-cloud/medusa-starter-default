/**
 * src/api/admin/inventory-counts/[id]/approve/route.ts
 *
 * POST /admin/inventory-counts/:id/approve (manager-only)
 *
 * Loads the count + lines + live stock, then runs approveInventoryCountWorkflow.
 * The workflow handles classification (with the projected-negative guard),
 * compensable stock adjustments, line-status persistence, and QB pipeline
 * enqueue grouped by account.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { approveInventoryCountWorkflow } from "../../../../../workflows/inventory-count/approve-inventory-count";
import {
  ManagerRoleRequiredError,
  UnauthenticatedError,
  requireManager,
} from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getInventoryCountService } from "../../_lib/service-resolver";
import type { ApprovalDecision } from "../../_lib/types";
import { approveSchema } from "../../_lib/validators";

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
}

export async function POST(
  req: AuthenticatedMedusaRequest<{ decisions: ApprovalDecision[] }>,
  res: MedusaResponse
) {
  let reviewerId: string;
  try {
    reviewerId = await requireManager(req);
  } catch (err) {
    if (
      err instanceof ManagerRoleRequiredError ||
      err instanceof UnauthenticatedError
    ) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { decisions } = parsed.data;

  const id = req.params.id as string;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "submitted" && count.status !== "partially_applied") {
    return res.status(409).json({
      error: `Cannot approve a ${count.status} count`,
      code: "not_submitted",
    });
  }

  // Load lines that are still pending or blocked (re-approval after partial)
  const lines = await service.listInventoryCountLines(
    {
      inventory_count_id: id,
      status: ["pending", "blocked"],
    },
    { take: 5000, order: { sku: "ASC" } }
  );

  if (lines.length === 0) {
    return res.status(400).json({
      error: "No pending lines to approve",
      code: "no_pending_lines",
    });
  }

  // Snapshot live stock for all line items
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

  const workflowInput = {
    count_id: id,
    count_number: count.number ?? "",
    count_memo: count.memo ?? "",
    stock_location_id: count.stock_location_id,
    reviewed_by_user_id: reviewerId,
    total_lines: lines.length,
    lines: lines.map((l) => ({
      line_id: l.id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku: l.sku,
      qty_at_count_time: l.qty_at_count_time ?? 0,
      qty_counted: l.qty_counted ?? 0,
      delta_original: l.delta_original ?? 0,
      current_stock_now: stockByItem.get(l.inventory_item_id) ?? 0,
      qb_account_list_id_line: l.qb_account_list_id,
      qb_account_list_id_default: count.default_qb_account_list_id,
    })),
    decisions,
  };

  const { result } = await approveInventoryCountWorkflow(req.scope).run({
    input: workflowInput,
  });

  return res.status(200).json({
    inventory_count_id: id,
    status: result.status,
    applied_lines: result.applied,
    blocked_lines: result.blocked,
    skipped_lines: result.skipped,
    qb_pipeline_ids: result.qb_pipeline_ids,
  });
}
