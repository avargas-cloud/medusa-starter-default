/**
 * src/scripts/fix/repair-dropped-inventory-count-deltas.ts
 *
 * Repairs inventory-count lines whose counted variance was silently DROPPED:
 *   status='verified' AND delta_applied=0 AND delta_original<>0
 * (the old available-based negative guard blocked them, then an override seeded
 * to current stock zeroed them → no adjustment in store-pos OR QuickBooks).
 *
 * RULE — dedup by the most recent count per SKU (avoids double-counting):
 *   For each dropped line we look at the most RECENT count (by seq) that
 *   actually measured the same inventory_item_id (qty_counted IS NOT NULL, any
 *   status incl. pending, non-voided). We repair the dropped line ONLY if it is
 *   that most-recent count. If a newer count exists for the SKU we SKIP it:
 *     - newer count already applied correctly → reality is already right;
 *     - newer count still pending → approving it (under the fixed code) applies
 *       the correct current delta. Applying the stale dropped delta now would
 *       double-correct.
 *
 * Repair = apply delta_original on top of CURRENT stock (delta is movement-
 * invariant), set the line to 'applied', flag resulted_negative if it lands
 * below 0, and enqueue the QB inventory adjustment (unique reference_id).
 *
 * Idempotent: a repaired line is no longer 'verified' so re-runs skip it; a
 * skipped (superseded) line stays skipped as long as the newer count exists.
 *
 * DRY_RUN first (read-only — prints the REPAIR/SKIP plan):
 *   DRY_RUN=true env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/repair-dropped-inventory-count-deltas.ts
 * Then for real (drop DRY_RUN).
 */
import { Modules } from "@medusajs/utils";
import { randomUUID } from "crypto";

import { getDbPool } from "../../api/utils/db-pool";
import { INVENTORY_COUNT_MODULE } from "../../modules/inventory-count";

const DRY_RUN = process.env.DRY_RUN === "true";

interface Candidate {
  line_id: string;
  inventory_item_id: string;
  product_variant_id: string;
  sku: string;
  delta_original: number;
  inventory_count_id: string;
  count_number: string;
  qb_account_list_id: string | null;
  default_qb_account_list_id: string;
  count_memo: string | null;
  stock_location_id: string;
  superseded_by: string | null; // newer count number, or null if this is latest
}

export default async function repairDroppedDeltas({
  container,
}: {
  container: any;
}) {
  const logger = container.resolve("logger") as any;
  const prefix = DRY_RUN ? "[DRY-RUN repair-dropped]" : "[repair-dropped]";

  const service = container.resolve(INVENTORY_COUNT_MODULE) as any;
  const inventory = container.resolve(Modules.INVENTORY) as any;
  const pg = getDbPool();

  // Candidates + the most-recent SUPERSEDING count (if any) per SKU.
  const { rows } = await pg.query<Candidate>(
    `WITH dropped AS (
       SELECT l.id AS line_id, l.inventory_item_id, l.product_variant_id, l.sku,
              l.delta_original::int AS delta_original, l.inventory_count_id,
              c.number AS count_number, c.seq AS count_seq,
              l.qb_account_list_id, c.default_qb_account_list_id,
              c.memo AS count_memo, c.stock_location_id
       FROM inventory_count_line l
       JOIN inventory_count c ON c.id = l.inventory_count_id
       WHERE l.status = 'verified'
         AND COALESCE(l.delta_applied, 0) = 0
         AND COALESCE(l.delta_original, 0) <> 0
         AND l.deleted_at IS NULL AND c.deleted_at IS NULL
         AND c.status IN ('approved','partially_applied') AND c.voided_at IS NULL
     )
     SELECT d.line_id, d.inventory_item_id, d.product_variant_id, d.sku,
            d.delta_original, d.inventory_count_id, d.count_number,
            d.qb_account_list_id, d.default_qb_account_list_id,
            d.count_memo, d.stock_location_id,
            (SELECT c2.number
               FROM inventory_count_line l2
               JOIN inventory_count c2 ON c2.id = l2.inventory_count_id
              WHERE l2.inventory_item_id = d.inventory_item_id
                AND l2.qty_counted IS NOT NULL
                AND l2.deleted_at IS NULL AND c2.deleted_at IS NULL
                AND c2.voided_at IS NULL
                AND c2.seq > d.count_seq
              ORDER BY c2.seq DESC LIMIT 1) AS superseded_by
     FROM dropped d
     ORDER BY d.count_number, d.sku`
  );

  if (rows.length === 0) {
    logger.info(`${prefix} no dropped lines found — nothing to repair.`);
    return;
  }

  const toRepair = rows.filter((r) => !r.superseded_by);
  const toSkip = rows.filter((r) => r.superseded_by);

  logger.info(
    `${prefix} ${rows.length} dropped line(s): ${toRepair.length} to repair, ${toSkip.length} superseded (skip).`
  );
  for (const r of toSkip) {
    logger.info(
      `${prefix} SKIP ${r.count_number} ${r.sku} (Δ ${r.delta_original}) — superseded by newer count ${r.superseded_by}`
    );
  }

  const affectedCounts = new Set<string>();

  for (const r of toRepair) {
    const account = r.qb_account_list_id ?? r.default_qb_account_list_id;
    const levels = await inventory.listInventoryLevels(
      { inventory_item_id: r.inventory_item_id, location_id: r.stock_location_id },
      { take: 1 }
    );
    const preStock = levels[0]?.stocked_quantity ?? 0;
    const newStock = preStock + r.delta_original;

    logger.info(
      `${prefix} REPAIR ${r.count_number} ${r.sku}: stock ${preStock} ${r.delta_original > 0 ? "+" : ""}${r.delta_original} → ${newStock}` +
        (newStock < 0 ? " (NEGATIVE — allowed, flagged)" : "")
    );

    if (DRY_RUN) continue;

    // 1. Apply the delta to Medusa stock (fires the Meili PG trigger too).
    await inventory.adjustInventory(
      r.inventory_item_id,
      r.stock_location_id,
      r.delta_original
    );

    // 2. Update the line to its true applied outcome.
    await service.updateInventoryCountLines([
      {
        id: r.line_id,
        status: "applied",
        delta_applied: r.delta_original,
        qty_at_apply_time: preStock,
        projected_stock: newStock,
        qb_account_list_id: account,
        resulted_negative: newStock < 0,
      },
    ]);

    // 3. Enqueue the QB inventory adjustment. Unique reference_id (":repair:" +
    //    line id) so it never collides with the count's existing group row.
    const referenceId = `${r.inventory_count_id}:${account}:repair:${r.line_id}`;
    const payload = {
      count_id: r.inventory_count_id,
      count_number: r.count_number,
      count_memo: r.count_memo ?? "",
      qb_account_list_id: account,
      txn_date: new Date().toISOString().slice(0, 10),
      lines: [
        {
          line_id: r.line_id,
          inventory_item_id: r.inventory_item_id,
          product_variant_id: r.product_variant_id,
          sku: r.sku,
          delta_applied: r.delta_original,
          new_stock: newStock,
        },
      ],
    };
    const { rows: updated } = await pg.query(
      `UPDATE qb_order_pipeline
          SET status='pending', payload=$2::jsonb, error=NULL,
              next_retry_at=NULL, updated_at=NOW()
        WHERE reference_id=$1 AND step='inventory_adjustment'
          AND status IN ('pending','failed')
        RETURNING id`,
      [referenceId, JSON.stringify(payload)]
    );
    if (updated.length === 0) {
      await pg.query(
        `INSERT INTO qb_order_pipeline
           (id, order_id, reference_id, reference_type, step, status, payload,
            medusa_ref_number, created_at, updated_at)
         VALUES ($1,$2,$3,'inventory_count','inventory_adjustment','pending',
                 $4::jsonb,$5,NOW(),NOW())`,
        [randomUUID(), r.inventory_count_id, referenceId, JSON.stringify(payload), r.count_number]
      );
    }

    affectedCounts.add(r.inventory_count_id);
    logger.info(`${prefix} ${r.sku}: applied + QB enqueued (${referenceId})`);
  }

  // Refresh header counters (accumulative) for every count we touched.
  if (!DRY_RUN) {
    for (const countId of affectedCounts) {
      const all = await service.listInventoryCountLines(
        { inventory_count_id: countId },
        { take: 5000 }
      );
      const by = (s: string[]) => all.filter((x: any) => s.includes(x.status)).length;
      const status =
        by(["pending"]) === 0 && by(["blocked"]) === 0
          ? "approved"
          : "partially_applied";
      await service.updateInventoryCounts([
        {
          id: countId,
          status,
          total_lines_applied: by(["applied", "overridden"]),
          total_lines_blocked: by(["blocked"]),
        },
      ]);
    }
  }

  logger.info(
    `${prefix} done — ${toRepair.length} line(s) ${DRY_RUN ? "would be" : ""} repaired, ${toSkip.length} skipped (superseded).`
  );
}
