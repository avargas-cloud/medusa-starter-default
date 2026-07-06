/**
 * src/api/admin/china-adjustment/[id]/route.ts
 *
 * GET /admin/china-adjustment/:id  — adjustment document detail with all lines
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import {
  CHINA_LOCATION_ID,
  type InventoryServiceLike,
  resolveKnex,
  syncChinaAdjustmentItemsToMeili,
} from "../route";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../../purchase-orders/_lib/auth";
import {
  computeChinaAdjustment,
  loadChinaLevels,
} from "../_lib/china-adjustment-math";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const knex = resolveKnex(req);

  const { rows: docs } = await knex.raw(
    `SELECT id, notes, total_lines, created_by_user_id, created_at,
            voided_at, voided_by_user_id, void_reason
     FROM china_adjustment WHERE id = ?`,
    [id]
  );

  if (!docs || (docs as unknown[]).length === 0) {
    return res.status(404).json({ error: "Adjustment not found." });
  }

  const { rows: lines } = await knex.raw(
    `SELECT id, inventory_item_id, sku, old_qty, new_qty, delta
     FROM china_adjustment_line
     WHERE china_adjustment_id = ?
     ORDER BY sku ASC`,
    [id]
  );

  return res.json({ adjustment: (docs as unknown[])[0], lines });
}

interface LineInput {
  inventory_item_id: string;
  sku: string;
  new_quantity: number;
}

interface PatchBody {
  notes?: string | null;
  lines?: LineInput[];
}

interface ExistingLine {
  inventory_item_id: string;
  sku: string;
  old_qty: number;
  new_qty: number;
  delta: number;
}

export async function PATCH(
  req: AuthenticatedMedusaRequest<PatchBody>,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(401).json({ error: err.message });
    }
    throw err;
  }

  const { id } = req.params;
  const { notes, lines } = req.body;
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: "lines must be an array." });
  }

  const seen = new Set<string>();
  for (const l of lines) {
    if (
      !l.inventory_item_id ||
      !l.sku ||
      typeof l.new_quantity !== "number" ||
      l.new_quantity < 0 ||
      !Number.isInteger(l.new_quantity)
    ) {
      return res.status(400).json({
        error: `Invalid line for sku "${l.sku ?? "?"}": new_quantity must be a non-negative integer.`,
      });
    }
    if (seen.has(l.inventory_item_id)) {
      return res.status(400).json({
        error: `Duplicate inventory item in adjustment: ${l.sku}`,
      });
    }
    seen.add(l.inventory_item_id);
  }

  const knex = resolveKnex(req);
  const docRes = await knex.raw(
    `SELECT id, voided_at FROM china_adjustment WHERE id = ?`,
    [id]
  );
  const docRow = (docRes.rows as Array<{ voided_at: string | null }>)[0];
  if (!docRow) {
    return res.status(404).json({ error: "Adjustment not found." });
  }
  if (docRow.voided_at) {
    return res.status(409).json({
      error: "This adjustment is voided and can no longer be edited.",
      code: "ADJUSTMENT_VOIDED",
    });
  }

  const existingRes = await knex.raw(
    `SELECT inventory_item_id, sku, old_qty, new_qty, delta
     FROM china_adjustment_line
     WHERE china_adjustment_id = ?`,
    [id]
  );
  const existingLines = existingRes.rows as ExistingLine[];
  const existingByItem = new Map(
    existingLines.map((line) => [line.inventory_item_id, line])
  );
  const requestedIds = new Set(lines.map((l) => l.inventory_item_id));

  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike;

  const itemIds = Array.from(
    new Set([
      ...lines.map((l) => l.inventory_item_id),
      ...existingLines.map((l) => l.inventory_item_id),
    ])
  );
  // Physical-basis snapshot (stocked + in_transit). `new_quantity` is a PHYSICAL
  // count; in_transit is preserved on top of stocked. See
  // `../_lib/china-adjustment-math.ts`.
  const levels = await loadChinaLevels(
    knex,
    inventoryService,
    CHINA_LOCATION_ID,
    itemIds
  );

  const appliedLines: Array<{
    inventory_item_id: string;
    sku: string;
    old_qty: number;
    new_qty: number;
    delta: number;
  }> = [];
  const warnings: string[] = [];

  for (const line of lines) {
    const level = levels.get(line.inventory_item_id) ?? {
      stocked: 0,
      committed: 0,
      in_transit: 0,
    };
    const existing = existingByItem.get(line.inventory_item_id);
    const reserved = level.committed + level.in_transit;

    // Delta-differential: an EXISTING line moves by the difference from its
    // PREVIOUS entered count (not vs live stock), so the stored net `delta`
    // always equals the actual movement this adjustment applied — that is what
    // makes a later void (reverse `-delta`) exact even when sales/receives
    // happened between edits. A NEW line behaves like a create (move from live).
    let oldQty: number;
    let appliedDelta: number;
    if (existing) {
      oldQty = existing.old_qty;
      appliedDelta = line.new_quantity - existing.new_qty;
    } else {
      const m = computeChinaAdjustment(level, line.new_quantity);
      oldQty = m.oldAvailable;
      appliedDelta = m.delta;
    }

    if (appliedDelta !== 0) {
      await inventoryService.adjustInventory(
        line.inventory_item_id,
        CHINA_LOCATION_ID,
        appliedDelta
      );
    }
    if (reserved > level.stocked) {
      warnings.push(
        `${line.sku}: reserved transfers (${reserved}) exceed stocked (${level.stocked}) — pre-existing phantom, adjustment applied as-is`
      );
    }
    appliedLines.push({
      inventory_item_id: line.inventory_item_id,
      sku: line.sku,
      old_qty: oldQty,
      new_qty: line.new_quantity,
      delta: line.new_quantity - oldQty,
    });
  }

  const removedLines = existingLines.filter(
    (line) => !requestedIds.has(line.inventory_item_id)
  );
  for (const line of removedLines) {
    // Removing a line reverses its net contribution (movement-invariant: undo
    // exactly what it applied), surviving any intermediate stock changes.
    if (line.delta !== 0) {
      await inventoryService.adjustInventory(
        line.inventory_item_id,
        CHINA_LOCATION_ID,
        -line.delta
      );
    }
  }

  await knex.raw(
    `UPDATE china_adjustment SET notes = ?, total_lines = ? WHERE id = ?`,
    [notes ?? null, appliedLines.length, id]
  );
  await knex.raw(`DELETE FROM china_adjustment_line WHERE china_adjustment_id = ?`, [
    id,
  ]);

  for (const al of appliedLines) {
    const lineId = `chadj_ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await knex.raw(
      `INSERT INTO china_adjustment_line
         (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lineId, id, al.inventory_item_id, al.sku, al.old_qty, al.new_qty, al.delta]
    );
  }

  const meili = await syncChinaAdjustmentItemsToMeili(req, itemIds);

  return res.json({
    adjustment: {
      id,
      notes: notes ?? null,
      total_lines: appliedLines.length,
      meili,
      warnings,
    },
    lines: appliedLines,
  });
}
