/**
 * src/api/admin/inventory-counts/[id]/void/route.ts
 *
 * POST /admin/inventory-counts/:id/void (manager-only)
 *
 * Voids a previously approved count. Reverses the original stock deltas in
 * Medusa, marks the count 'voided', and queues a TxnVoidRq to QuickBooks
 * for every pipeline row that was already synced.
 *
 * Preconditions: count.status IN ('approved','partially_applied'). Already
 * voided / draft / submitted / rejected / cancelled counts return 409.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  ManagerRoleRequiredError,
  UnauthenticatedError,
  requireManager,
} from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getInventoryCountService } from "../../_lib/service-resolver";
import { voidSchema } from "../../_lib/validators";

import { voidInventoryCountWorkflow } from "../../../../../workflows/inventory-count/void-inventory-count";

interface PipelineRowLite {
  id: string;
  status: string;
  qb_list_id: string | null;
  void_status: string | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest<{ void_reason: string }>,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = await requireManager(req);
  } catch (err) {
    if (
      err instanceof ManagerRoleRequiredError ||
      err instanceof UnauthenticatedError
    ) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = voidSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { void_reason } = parsed.data;

  const id = req.params.id as string;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res.status(404).json({
      error: "inventory_count not found",
      code: "not_found",
    });
  }
  if (count.status !== "approved" && count.status !== "partially_applied") {
    return res.status(409).json({
      error: `Only approved counts can be voided (current status: ${count.status})`,
      code: "not_voidable",
    });
  }

  // Lines that actually moved stock (applied or overridden) must be reversed.
  // Skipped / blocked / verified lines never touched stock — leave them.
  const allLines = await service.listInventoryCountLines(
    {
      inventory_count_id: id,
      status: ["applied", "overridden"],
    },
    { take: 5000 }
  );

  const linesToReverse = allLines
    .filter((l) => (l.delta_applied ?? 0) !== 0)
    .map((l) => ({
      line_id: l.id,
      inventory_item_id: l.inventory_item_id,
      delta_applied: l.delta_applied ?? 0,
    }));

  // Pipeline rows that already reached QB (have qb_list_id, status='synced')
  // are the ones we need to void in QB. Rows still in error/waiting/processing
  // are dropped from the QB-side flow — we can't void what was never sent.
  const pipelineRows = (await service.listQbInventoryAdjustmentPipelines(
    { inventory_count_id: id },
    { take: 100 }
  )) as PipelineRowLite[];

  const rowsToVoid = pipelineRows
    .filter(
      (r) => r.status === "synced" && !!r.qb_list_id && r.void_status === null
    )
    .map((r) => r.id);

  try {
    const { result } = await voidInventoryCountWorkflow(req.scope).run({
      input: {
        count_id: id,
        voided_by_user_id: userId,
        void_reason,
        stock_location_id: count.stock_location_id,
        lines_to_reverse: linesToReverse,
        pipeline_row_ids_to_void: rowsToVoid,
      },
    });

    return res.status(200).json({
      inventory_count_id: id,
      reversed_stock_lines: result.reversed_count,
      voided_lines: result.voided_line_count,
      qb_void_queued: result.pipeline_void_queued,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "void failed";
    return res.status(409).json({ error: message, code: "void_failed" });
  }
}
