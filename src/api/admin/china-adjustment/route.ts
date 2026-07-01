/**
 * src/api/admin/china-adjustment/route.ts
 *
 * GET  /admin/china-adjustment  — list all adjustment documents (newest first)
 * POST /admin/china-adjustment  — create a new batch adjustment document
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../purchase-orders/_lib/auth";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../workflows/sync-inventory-item-meilisearch";
import {
  computeChinaAdjustment,
  loadChinaLevels,
} from "./_lib/china-adjustment-math";

export const CHINA_LOCATION_ID = "sloc_01KQ14C1CFX30EDD722BF87HDM";

// ── Knex ──────────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── Inventory module ───────────────────────────────────────────────────────────

export interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
  adjustInventory: (
    inventory_item_id: string,
    location_id: string,
    adjustment: number
  ) => Promise<void>;
}

export async function syncChinaAdjustmentItemsToMeili(
  req: AuthenticatedMedusaRequest,
  inventoryItemIds: string[]
) {
  const logger = req.scope.resolve("logger") as {
    warn: (m: string) => void;
    info: (m: string) => void;
  };
  const uniqueIds = Array.from(new Set(inventoryItemIds.filter(Boolean)));
  if (uniqueIds.length === 0) return { synced: 0, failed: 0 };

  const results = await Promise.allSettled(
    uniqueIds.map((inventoryItemId) =>
      syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
        input: { inventoryItemId },
      })
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  for (const r of failed) {
    const reason = (r as PromiseRejectedResult).reason;
    logger.warn(
      `[china-adjustment] Meili sync failed: ${reason?.message ?? reason}`
    );
  }
  logger.info(
    `[china-adjustment] synced ${results.length - failed.length}/${results.length} inventory item(s) to Meili`
  );
  return { synced: results.length - failed.length, failed: failed.length };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const knex = resolveKnex(req);
  const limit = Math.min(
    parseInt((req.query as Record<string, string>).limit ?? "50", 10),
    200
  );

  const { rows } = await knex.raw(
    `SELECT ca.id, ca.notes, ca.total_lines, ca.created_by_user_id, ca.created_at,
            COALESCE(SUM(ABS(cl.delta)), 0)::int AS total_units_changed
     FROM china_adjustment ca
     LEFT JOIN china_adjustment_line cl ON cl.china_adjustment_id = ca.id
     GROUP BY ca.id
     ORDER BY ca.created_at DESC
     LIMIT ?`,
    [limit]
  );

  return res.json({ adjustments: rows });
}

// ── POST ──────────────────────────────────────────────────────────────────────

interface LineInput {
  inventory_item_id: string;
  sku: string;
  new_quantity: number;
}

interface PostBody {
  lines: LineInput[];
  notes?: string | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest<PostBody>,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(401).json({ error: err.message });
    }
    throw err;
  }

  const { lines, notes } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines must be a non-empty array." });
  }

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
  }

  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike;
  const knex = resolveKnex(req);

  // Snapshot current stocked + in_transit (physical-basis adjustment). The
  // operator's `new_quantity` is a PHYSICAL count; in_transit is added back so
  // stocked keeps carrying shipped-but-not-received transfer units. See
  // `_lib/china-adjustment-math.ts`.
  const itemIds = lines.map((l) => l.inventory_item_id);
  const levels = await loadChinaLevels(
    knex,
    inventoryService,
    CHINA_LOCATION_ID,
    itemIds
  );

  // Apply adjustments
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
      in_transit: 0,
    };
    const m = computeChinaAdjustment(level, line.new_quantity);
    if (m.delta !== 0) {
      await inventoryService.adjustInventory(
        line.inventory_item_id,
        CHINA_LOCATION_ID,
        m.delta
      );
    }
    if (m.preexistingPhantom) {
      warnings.push(
        `${line.sku}: shipped reservations (${level.in_transit}) exceed stocked (${level.stocked}) — pre-existing phantom, adjustment applied as-is`
      );
    }
    appliedLines.push({
      inventory_item_id: line.inventory_item_id,
      sku: line.sku,
      old_qty: m.oldPhysical,
      new_qty: m.newPhysical,
      delta: m.delta,
    });
  }

  // Persist the adjustment document + lines
  const id = `chadj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await knex.raw(
    `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, now())`,
    [id, notes ?? null, appliedLines.length, userId]
  );

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

  return res
    .status(201)
    .json({ adjustment: { id, lines: appliedLines, meili, warnings } });
}
