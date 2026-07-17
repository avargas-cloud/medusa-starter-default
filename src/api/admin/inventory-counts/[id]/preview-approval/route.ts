/**
 * src/api/admin/inventory-counts/[id]/preview-approval/route.ts
 *
 * GET /admin/inventory-counts/:id/preview-approval (manager-only)
 *
 * Returns each submitted line annotated with current_stock_now and
 * projected_stock so the manager UI can flag lines that would block
 * before they hit Approve.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { avgCostDollars } from "../../../../../lib/cost/cost-sql";

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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
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

  // Resolve unit cost per variant. Same precedence used elsewhere for
  // inventory-adjustment COGS (reports/sales/summary fetchInventoryAdjCogs):
  // average_unit_cost → fallback qb_avg_cost (both in dollars).
  const variantIds = Array.from(
    new Set(lines.map((l) => l.product_variant_id).filter((id): id is string => !!id))
  );
  const costByVariant = new Map<string, number | null>();
  const salesDescByVariant = new Map<string, string | null>();
  if (variantIds.length > 0) {
    const pg = req.scope.resolve("__pg_connection__") as {
      raw: (
        sql: string,
        bindings?: unknown[]
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const result = await pg.raw(
      `SELECT id,
              ${avgCostDollars("product_variant")} AS unit_cost,
              NULLIF(TRIM(metadata->>'sales_description'), '') AS sales_description
         FROM product_variant
        WHERE id = ANY(?)`,
      [variantIds]
    );
    for (const row of result.rows) {
      const raw = row.unit_cost;
      const n =
        raw === null || raw === undefined || raw === ""
          ? null
          : Number(raw);
      costByVariant.set(
        String(row.id),
        n !== null && Number.isFinite(n) ? n : null
      );
      salesDescByVariant.set(
        String(row.id),
        row.sales_description ? String(row.sales_description) : null
      );
    }
  }

  const previewLines: PreviewApprovalLine[] = lines.map((l) => {
    const current = stockByItem.get(l.inventory_item_id) ?? 0;
    const delta = l.delta_original ?? 0;
    const projected = current + delta;
    const willGoNegative = projected < 0;
    return {
      line_id: l.id,
      sku: l.sku,
      product_title: l.product_title,
      product_sales_description:
        salesDescByVariant.get(l.product_variant_id) ?? null,
      qty_at_count_time: l.qty_at_count_time ?? 0,
      qty_counted: l.qty_counted ?? 0,
      delta_original: delta,
      current_stock_now: current,
      projected_stock: projected,
      // Informational only — never blocks. delta_original is applied as-is.
      will_go_negative: willGoNegative,
      block_reason: null,
      qb_account_list_id:
        l.qb_account_list_id ?? count.default_qb_account_list_id,
      unit_cost: costByVariant.get(l.product_variant_id) ?? null,
    };
  });

  // Every line with a non-zero delta will apply (no negative block anymore).
  const applyLines = previewLines.filter((l) => l.delta_original !== 0);
  const cost_impact_dollars = applyLines.reduce(
    (acc, l) => acc + l.delta_original * (l.unit_cost ?? 0),
    0
  );
  const cost_impact_has_missing = applyLines.some(
    (l) => l.delta_original !== 0 && l.unit_cost === null
  );
  const summary = {
    total_lines: previewLines.length,
    will_apply: applyLines.length,
    will_go_negative: previewLines.filter((l) => l.will_go_negative).length,
    positive_delta_units: applyLines
      .filter((l) => l.delta_original > 0)
      .reduce((acc, l) => acc + l.delta_original, 0),
    negative_delta_units: applyLines
      .filter((l) => l.delta_original < 0)
      .reduce((acc, l) => acc + l.delta_original, 0),
    net_delta_units: applyLines.reduce((acc, l) => acc + l.delta_original, 0),
    cost_impact_dollars,
    cost_impact_has_missing,
  };

  return res.json({
    inventory_count: count,
    lines: previewLines,
    summary,
  });
}
