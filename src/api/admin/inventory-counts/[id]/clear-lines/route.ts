/**
 * src/api/admin/inventory-counts/[id]/clear-lines/route.ts
 *
 * POST /admin/inventory-counts/:id/clear-lines
 *
 * Wipes every line on a draft. The editor may remain open so the cashier can
 * add a different product set. If they abandon the empty draft, DELETE removes
 * the header instead of keeping a zero-line document.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getInventoryCountService } from "../../_lib/service-resolver";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const id = req.params.id as string;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts may be cleared (current status: ${count.status})`,
      code: "not_draft",
    });
  }

  const lines = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000 }
  );

  const deleted = lines.length;
  if (deleted > 0) {
    await service.deleteInventoryCountLines(lines.map((l) => l.id));
  }

  await service.updateInventoryCounts([
    {
      id,
      total_lines: 0,
      total_lines_applied: 0,
      total_lines_blocked: 0,
      total_delta_units: 0,
    },
  ]);

  return res.json({ id, cleared: true, deleted });
}
