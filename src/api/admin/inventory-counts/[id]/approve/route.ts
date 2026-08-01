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
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { Knex } from "knex";

import {
  acquireItemClaims,
  beginApproval,
  describeClaimConflicts,
  endApproval,
  releaseClaimsForLines,
} from "../../../../../lib/inventory-count/item-claims";
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
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number; reserved_quantity: number }>>;
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
  // Use physical stocked_quantity (NOT available) — the adjustment operates on
  // stocked, the delta is movement-invariant, and reservations must not change
  // the correction. This matches preview-approval so the manager sees exactly
  // what will be applied. Negative results are allowed (flagged downstream).
  const stockByItem = new Map<string, number>();
  for (const lvl of levels) {
    stockByItem.set(lvl.inventory_item_id, lvl.stocked_quantity ?? 0);
  }

  // ── Item exclusivity ──────────────────────────────────────────────────────
  //
  // The submit guard cannot protect counts that were ALREADY submitted when it
  // shipped: those deltas were armed through a door that did not exist yet.
  // Approve is the last gate before stock and QuickBooks move, so it re-checks.
  //
  // Step 1 doubles as a self-heal: acquire is idempotent for the same count, so
  // a line we already own is a no-op, a line nobody owns gets claimed now, and
  // a line owned by ANOTHER count comes back as a conflict.
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

  // Step 2: stamp the claims as "approval in flight". This is the mutex — the
  // second of two concurrent approvals matches no rows and must abort instead
  // of applying the same deltas again.
  //
  // The claims stay in the table while the workflow runs. Removing them to take
  // the lock would leave these items free for its whole duration, so a request
  // arriving in that window would claim them and apply the delta a second time.
  const lineIds = lines.map((l) => l.id);
  const locked = await beginApproval(knex, id, lineIds);

  if (locked.length !== lines.length) {
    // Release only what THIS request stamped; the rest belongs to the winner.
    await endApproval(
      knex,
      locked.map((l) => l.inventory_count_line_id)
    );
    return res.status(409).json({
      error:
        "This count is already being approved by another request. Wait for it " +
        "to finish and reload before approving again.",
      code: "approval_in_progress",
    });
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
    skip_qb_sync: (count as Record<string, unknown>).skip_qb_sync === true,
  };

  // Wrapped in a closure so TypeScript keeps inferring the workflow's result
  // type; a pre-declared `let` outside the try would widen it to unknown.
  const runApproval = async () => {
    try {
      return await approveInventoryCountWorkflow(req.scope).run({
        input: workflowInput,
      });
    } catch (err) {
      // The workflow compensates its own writes back to submitted/pending, so
      // every line is armed again. The claims never left the table — only the
      // in-flight stamp has to come off so the count can be approved later.
      await endApproval(knex, lineIds);
      throw err;
    }
  };

  const { result } = await runApproval();

  // Settle the claims. `applied` / `overridden` / `verified` / `skipped` are
  // terminal and release the item; a `blocked` line keeps its frozen delta and
  // can be approved in a later pass, so it keeps its claim and only loses the
  // in-flight stamp.
  //
  // Read the surviving lines back from the database instead of deriving them
  // from the workflow result: the source of truth for "still armed" is the line
  // status the persist step actually wrote.
  const stillArmed = await service.listInventoryCountLines(
    { inventory_count_id: id, status: ["pending", "blocked"] },
    { take: 5000 }
  );
  const stillArmedIds = new Set(stillArmed.map((l) => l.id));

  await endApproval(knex, [...stillArmedIds]);
  await releaseClaimsForLines(
    knex,
    lineIds.filter((lid) => !stillArmedIds.has(lid))
  );

  return res.status(200).json({
    inventory_count_id: id,
    status: result.status,
    applied_lines: result.applied,
    blocked_lines: result.blocked,
    skipped_lines: result.skipped,
    qb_pipeline_ids: result.qb_pipeline_ids,
  });
}
