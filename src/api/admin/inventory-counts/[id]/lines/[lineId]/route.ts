/**
 * src/api/admin/inventory-counts/[id]/lines/[lineId]/route.ts
 *
 * DELETE /admin/inventory-counts/:id/lines/:lineId
 *
 * Removes a single line from a draft. Single-line delete needs its own
 * endpoint because the PATCH /admin/inventory-counts/:id route uses upsert
 * semantics — sending a payload that omits a line does NOT delete it.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getInventoryCountService } from "../../../_lib/service-resolver";

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const id = req.params.id as string;
  const lineId = req.params.lineId as string;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "draft") {
    return res.status(409).json({
      error: `Lines can only be removed from drafts (current status: ${count.status})`,
      code: "not_draft",
    });
  }

  const [line] = await service.listInventoryCountLines(
    { id: lineId, inventory_count_id: id },
    { take: 1 }
  );
  if (!line) {
    return res
      .status(404)
      .json({ error: "line not found", code: "line_not_found" });
  }

  await service.deleteInventoryCountLines([lineId]);

  // Refresh denormalized counter
  const remaining = await service.listInventoryCountLines(
    { inventory_count_id: id },
    { take: 5000 }
  );
  await service.updateInventoryCounts([{ id, total_lines: remaining.length }]);

  return res.json({
    id: lineId,
    deleted: true,
    remaining_lines: remaining.length,
  });
}
