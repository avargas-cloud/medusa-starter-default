/**
 * apply-bulk-inventory-sync.ts
 *
 * Applies a bulk inventory correction (e.g. from QB Desktop or China import)
 * through the inventory_count module so every stock change has an audit trail.
 *
 * What it does:
 *   1. Cancels any open submitted counts for the affected items (stale deltas)
 *   2. Reads current stocked_quantity for each item; creates inventory_level at
 *      qty=0 for items that have no level yet
 *   3. Skips items whose QB qty matches Medusa exactly (no-op)
 *   4. Creates an inventory_count with source=<source> and skip_qb_sync=true
 *   5. Inserts count lines (qty_counted = qty_new, qty_at_count_time = current)
 *   6. Runs approveInventoryCountWorkflow with reviewed_by_user_id='system'
 *      → stock adjusted + MeiliSearch synced; QB enqueue skipped (source came FROM QB)
 *
 * Usage (from a medusa exec script):
 *   const result = await applyBulkInventorySync(container, {
 *     items, memo: "QB Stock Sync 2026-06-02", location_id: locationId,
 *     source: "qb_sync",
 *   });
 */

import { ulid } from "ulid";
import type { Knex } from "knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { approveInventoryCountWorkflow } from "../workflows/inventory-count/approve-inventory-count";
import { cancelOpenCountsForItems } from "./cancel-open-counts-for-items";
import { DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID } from "../modules/inventory-count/types";

export interface BulkSyncItem {
  inventory_item_id: string;
  variant_id: string;
  sku: string;
  product_title: string;
  qty_new: number;
}

export interface BulkSyncParams {
  items: BulkSyncItem[];
  memo: string;
  location_id: string;
  source: "qb_sync" | "china_sync";
  created_by_user_id?: string;
}

export interface BulkSyncResult {
  count_id: string | null;
  voided_prior_counts: number;
  applied: number;
  blocked: number;
  skipped_no_change: number;
}

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    opts?: { take?: number }
  ) => Promise<Array<{ id: string; inventory_item_id: string; stocked_quantity: number }>>;
  createInventoryLevels: (data: {
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
    incoming_quantity: number;
  }) => Promise<void>;
}

export async function applyBulkInventorySync(
  container: Parameters<typeof approveInventoryCountWorkflow>[0],
  params: BulkSyncParams
): Promise<BulkSyncResult> {
  const { items, memo, location_id, source, created_by_user_id = "system" } = params;

  if (items.length === 0) {
    return { count_id: null, voided_prior_counts: 0, applied: 0, blocked: 0, skipped_no_change: 0 };
  }

  const knex = (container as any).resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const inventoryService = (container as any).resolve(Modules.INVENTORY) as InventoryServiceLike;

  // ── Step 1: cancel open counts whose deltas would be invalidated ──────────
  const itemIds = items.map((i) => i.inventory_item_id);
  const voided = await cancelOpenCountsForItems(knex, itemIds, `${source} bulk sync`);

  // ── Step 2: snapshot current stocked_quantity for each item ───────────────
  const levels = await inventoryService.listInventoryLevels(
    { inventory_item_id: itemIds, location_id },
    { take: 5000 }
  );
  const stockByItem = new Map<string, number>();
  for (const l of levels) stockByItem.set(l.inventory_item_id, l.stocked_quantity ?? 0);

  // Create inventory_level at qty=0 for items with no existing level
  const missingLevelItems = items.filter((i) => !stockByItem.has(i.inventory_item_id));
  for (const item of missingLevelItems) {
    await inventoryService.createInventoryLevels({
      inventory_item_id: item.inventory_item_id,
      location_id,
      stocked_quantity: 0,
      incoming_quantity: 0,
    });
    stockByItem.set(item.inventory_item_id, 0);
  }

  // ── Step 3: filter out zero-delta items ───────────────────────────────────
  const toSync = items.filter((i) => {
    const current = stockByItem.get(i.inventory_item_id) ?? 0;
    return i.qty_new !== current;
  });
  const skipped_no_change = items.length - toSync.length;

  if (toSync.length === 0) {
    return { count_id: null, voided_prior_counts: voided.length, applied: 0, blocked: 0, skipped_no_change };
  }

  // ── Step 4: create inventory_count header ─────────────────────────────────
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "") +
    "-" + now.toISOString().slice(11, 16).replace(":", "");
  const countNumber = `${source === "qb_sync" ? "QBS" : "CHS"}-${stamp}`;
  const countId = `invcnt_${ulid()}`;

  await knex("inventory_count").insert({
    id: countId,
    number: countNumber,
    year: now.getFullYear(),
    seq: 0,
    status: "submitted",
    stock_location_id: location_id,
    memo,
    source,
    skip_qb_sync: true,
    default_qb_account_list_id: DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID,
    created_by_user_id,
    submitted_at: now,
    total_lines: toSync.length,
    total_lines_applied: 0,
    total_lines_blocked: 0,
    total_delta_units: toSync.reduce((acc, i) => {
      return acc + Math.abs(i.qty_new - (stockByItem.get(i.inventory_item_id) ?? 0));
    }, 0),
    created_at: now,
    updated_at: now,
  });

  // ── Step 5: insert count lines ────────────────────────────────────────────
  const lineRecords = toSync.map((item) => {
    const currentStock = stockByItem.get(item.inventory_item_id) ?? 0;
    return {
      id: `invcnl_${ulid()}`,
      inventory_count_id: countId,
      product_variant_id: item.variant_id,
      inventory_item_id: item.inventory_item_id,
      sku: item.sku,
      product_title: item.product_title,
      qty_counted: item.qty_new,
      qty_at_count_time: currentStock,
      delta_original: item.qty_new - currentStock,
      status: "pending",
      created_at: now,
      updated_at: now,
    };
  });

  await knex("inventory_count_line").insert(lineRecords);

  // ── Step 6: auto-approve via the standard workflow ────────────────────────
  const { result } = await approveInventoryCountWorkflow(container).run({
    input: {
      count_id: countId,
      count_number: countNumber,
      count_memo: memo,
      stock_location_id: location_id,
      reviewed_by_user_id: "system",
      total_lines: toSync.length,
      skip_qb_sync: true,
      lines: lineRecords.map((l) => ({
        line_id: l.id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku: l.sku,
        qty_at_count_time: l.qty_at_count_time,
        qty_counted: l.qty_counted,
        delta_original: l.delta_original,
        current_stock_now: l.qty_at_count_time,
        qb_account_list_id_line: null,
        qb_account_list_id_default: DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID,
      })),
      decisions: lineRecords.map((l) => ({ line_id: l.id, action: "apply" as const })),
    },
  });

  return {
    count_id: countId,
    voided_prior_counts: voided.length,
    applied: result.applied.length,
    blocked: result.blocked.length,
    skipped_no_change,
  };
}
