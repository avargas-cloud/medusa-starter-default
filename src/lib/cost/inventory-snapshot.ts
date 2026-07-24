import { randomUUID } from "crypto";

import { avgCostDollars, purchaseCostDollars } from "./cost-sql";
import { USA_LOC, CHINA_LOC } from "../locations";

/**
 * Capture an immutable inventory-valuation snapshot (Phase 2).
 *
 * Reconstructs, per variant, the quantity on hand as of `asOf` — using the
 * EXACT same movement sources and whole-owned-balance rule as the Supply Chain
 * report's fetchMiami/ChinaInventoryValueAtDate — and freezes it at the
 * variant's CURRENT canonical cost. For `asOf = now` the movement CTEs are all
 * empty and this collapses to "current stock × current cost", which is the
 * cutover-anchor case.
 *
 * We freeze CURRENT cost, not a historical one, on purpose: this snapshot's job
 * is to become a trustworthy boundary going forward ("as of this close, the
 * warehouse was worth X at the costs we knew then"), not to retro-price the
 * past. Its `cost_basis` records which cost was used so two snapshots are only
 * ever compared on the same basis.
 *
 * Immutable by contract: the writer only ever INSERTs. A correction is a NEW
 * snapshot plus moving the old one to `status='superseded'` — never an UPDATE
 * of a completed row's values.
 */

// Loose knex shape, matching the API routes in this codebase.
type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

export type Warehouse = "miami" | "china";
export type SnapshotType = "cutover_anchor" | "month_close" | "manual" | "nightly";

export interface CaptureResult {
  snapshotId: string;
  warehouse: Warehouse;
  locationId: string;
  asOf: string;
  variantCount: number;
  totalQuantity: number;
  totalValueCents: number;
}

// Per-variant reconstructed quantity as of a date, valued at current cost.
// Mirrors fetchMiamiInventoryValueAtDate's CTEs exactly, but emits one row per
// variant instead of a SUM. Whole owned balance — no reserved subtraction, no
// zero floor (Phase 1) — so a snapshot equals the report's number for the same
// instant.
function miamiRowsSql(): { sql: string; bind: (loc: string, asOf: string) => unknown[] } {
  const sql = `
    WITH cs AS (
      SELECT pv.id AS variant_id, il.stocked_quantity AS stocked,
             COALESCE(${avgCostDollars("pv")}, 0) AS unit_cost
      FROM inventory_level il
      JOIN inventory_item ii ON ii.id = il.inventory_item_id
      JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
      JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
      WHERE il.location_id = ?
    ),
    sold AS (
      SELECT ii.variant_id, SUM(ii.quantity) AS qty
      FROM pos_invoice i
      JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.deleted_at IS NULL
      WHERE i.deleted_at IS NULL AND i.voided_at IS NULL
        AND i.status NOT IN ('draft','voided') AND i.created_at >= ?::timestamptz
      GROUP BY ii.variant_id
    ),
    returned AS (
      SELECT cmi.variant_id, SUM(cmi.quantity - COALESCE(cmi.damaged_qty, 0)) AS qty
      FROM pos_credit_memo cm
      JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
      WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
        AND COALESCE(cm.completed_at, cm.created_at) >= ?::timestamptz
      GROUP BY cmi.variant_id
    ),
    received AS (
      SELECT porl.product_variant_id AS variant_id, SUM(porl.qty_received_now) AS qty
      FROM purchase_order_receipt_line porl
      JOIN purchase_order_receipt por ON por.id = porl.purchase_order_receipt_id
      WHERE por.stock_location_id = ? AND por.voided_at IS NULL AND por.deleted_at IS NULL
        AND porl.deleted_at IS NULL AND por.received_at >= ?::timestamptz
      GROUP BY porl.product_variant_id
    ),
    adjusted AS (
      SELECT icl.product_variant_id AS variant_id, SUM(icl.delta_applied) AS qty
      FROM inventory_count_line icl
      JOIN inventory_count ic ON ic.id = icl.inventory_count_id
      WHERE ic.stock_location_id = ? AND ic.status IN ('approved','partially_applied')
        AND ic.applied_at IS NOT NULL AND icl.deleted_at IS NULL AND ic.deleted_at IS NULL
        AND ic.voided_at IS NULL AND ic.applied_at >= ?::timestamptz
      GROUP BY icl.product_variant_id
    )
    SELECT cs.variant_id,
      (cs.stocked - (
        -COALESCE(s.qty, 0) + COALESCE(r.qty, 0) + COALESCE(rc.qty, 0) + COALESCE(a.qty, 0)
      ))::int AS quantity,
      cs.unit_cost
    FROM cs
    LEFT JOIN sold s ON s.variant_id = cs.variant_id
    LEFT JOIN returned r ON r.variant_id = cs.variant_id
    LEFT JOIN received rc ON rc.variant_id = cs.variant_id
    LEFT JOIN adjusted a ON a.variant_id = cs.variant_id
  `;
  return { sql, bind: (loc, asOf) => [loc, asOf, asOf, loc, asOf, loc, asOf] };
}

// China mirror of fetchChinaInventoryValueAtDate: fo_receipts(+) /
// transfers received in Miami(−) / manual china_adjustment(±), valued at
// factory (pre-landed) cost. Adjustments key on inventory_item, not variant.
function chinaRowsSql(): { sql: string; bind: (loc: string, asOf: string) => unknown[] } {
  const sql = `
    WITH cs AS (
      SELECT pv.id AS variant_id, ii.id AS inventory_item_id, il.stocked_quantity AS stocked,
             COALESCE(${purchaseCostDollars("pv")}, 0) AS unit_cost
      FROM inventory_level il
      JOIN inventory_item ii ON ii.id = il.inventory_item_id
      JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
      JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
      WHERE il.location_id = ?
    ),
    fo_receipts AS (
      SELECT forl.product_variant_id AS variant_id, SUM(forl.qty_received_now) AS qty
      FROM factory_order_receipt_line forl
      JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
      WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL AND fore.status = 'applied'
        AND fore.voided_at IS NULL AND fore.stock_location_id = ? AND fore.received_at >= ?::timestamptz
      GROUP BY forl.product_variant_id
    ),
    transfers_received AS (
      SELECT itl.product_variant_id AS variant_id, SUM(itl.qty) AS qty
      FROM inventory_transfer_line itl
      JOIN inventory_transfer it ON it.id = itl.transfer_id
      WHERE itl.deleted_at IS NULL AND it.deleted_at IS NULL AND it.origin_country = 'CN'
        AND it.voided_at IS NULL AND it.received_at IS NOT NULL AND it.received_at >= ?::timestamptz
      GROUP BY itl.product_variant_id
    ),
    adjustments AS (
      SELECT cl.inventory_item_id, SUM(cl.delta) AS delta
      FROM china_adjustment_line cl
      JOIN china_adjustment ca ON ca.id = cl.china_adjustment_id
      WHERE ca.voided_at IS NULL AND ca.created_at >= ?::timestamptz
      GROUP BY cl.inventory_item_id
    )
    SELECT cs.variant_id,
      (cs.stocked - (
        COALESCE(fo.qty, 0) - COALESCE(tr.qty, 0) + COALESCE(adj.delta, 0)
      ))::int AS quantity,
      cs.unit_cost
    FROM cs
    LEFT JOIN fo_receipts fo ON fo.variant_id = cs.variant_id
    LEFT JOIN transfers_received tr ON tr.variant_id = cs.variant_id
    LEFT JOIN adjustments adj ON adj.inventory_item_id = cs.inventory_item_id
  `;
  return { sql, bind: (loc, asOf) => [loc, loc, asOf, asOf, asOf] };
}

export async function captureInventoryValuationSnapshot(
  pg: Knex,
  opts: {
    warehouse: Warehouse;
    /** ISO instant the value represents. Defaults to now (cutover anchor). */
    asOf?: string;
    snapshotType: SnapshotType;
    note?: string;
    userId?: string;
  }
): Promise<CaptureResult> {
  const asOf = opts.asOf ?? new Date().toISOString();
  const locationId = opts.warehouse === "miami" ? USA_LOC : CHINA_LOC;
  const costBasis = opts.warehouse === "miami" ? "landed_avg" : "factory";
  const { sql: rowsSql, bind } =
    opts.warehouse === "miami" ? miamiRowsSql() : chinaRowsSql();

  const headerId = `ivs_${randomUUID()}`;
  const trx = pg.transaction ? await pg.transaction() : null;
  const run = trx ?? pg;
  try {
    await run.raw(
      `INSERT INTO inventory_valuation_snapshot
         (id, stock_location_id, as_of_at, snapshot_type, cost_basis, status,
          captured_by_user_id, source_note)
       VALUES (?, ?, ?::timestamptz, ?, ?, 'building', ?, ?)`,
      [headerId, locationId, asOf, opts.snapshotType, costBasis, opts.userId ?? null, opts.note ?? null]
    );

    // Freeze the lines in one pass. Skip zero-qty (noise), keep negatives —
    // an oversold SKU is a real negative carrying value (Phase 1). value_cents
    // rounds the qty × dollar-cost product once, at store time.
    await run.raw(
      `INSERT INTO inventory_valuation_snapshot_line
         (id, snapshot_id, product_variant_id, quantity, unit_cost, value_cents)
       SELECT 'ivsl_' || gen_random_uuid(), ?, r.variant_id, r.quantity, r.unit_cost,
              ROUND(r.quantity * r.unit_cost * 100)::bigint
       FROM (${rowsSql}) r
       WHERE r.quantity <> 0`,
      [headerId, ...bind(locationId, asOf)]
    );

    const agg = await run.raw(
      `SELECT COUNT(*)::int AS variant_count,
              COALESCE(SUM(quantity), 0)::bigint AS total_quantity,
              COALESCE(SUM(value_cents), 0)::bigint AS total_value_cents
       FROM inventory_valuation_snapshot_line WHERE snapshot_id = ?`,
      [headerId]
    );
    const a = agg.rows[0] as {
      variant_count: number;
      total_quantity: string | number;
      total_value_cents: string | number;
    };

    await run.raw(
      `UPDATE inventory_valuation_snapshot
          SET variant_count = ?, total_quantity = ?, total_value_cents = ?, status = 'complete'
        WHERE id = ?`,
      [a.variant_count, a.total_quantity, a.total_value_cents, headerId]
    );

    await trx?.commit();
    return {
      snapshotId: headerId,
      warehouse: opts.warehouse,
      locationId,
      asOf,
      variantCount: Number(a.variant_count),
      totalQuantity: Number(a.total_quantity),
      totalValueCents: Number(a.total_value_cents),
    };
  } catch (error) {
    await trx?.rollback().catch(() => {});
    throw error;
  }
}

/**
 * Latest COMPLETE snapshot for a location on or before an instant — the report's
 * future read path, and how a month-close finds its prior anchor. Returns the
 * header row or null. Kept read-only and dependency-free so it can be called
 * from anywhere without pulling in the capture machinery.
 */
export async function getSnapshotOnOrBefore(
  pg: Knex,
  locationId: string,
  asOf: string
): Promise<{ id: string; as_of_at: string; total_value_cents: number } | null> {
  const result = await pg.raw(
    `SELECT id, as_of_at, total_value_cents
       FROM inventory_valuation_snapshot
      WHERE stock_location_id = ? AND status = 'complete' AND as_of_at <= ?::timestamptz
      ORDER BY as_of_at DESC
      LIMIT 1`,
    [locationId, asOf]
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, as_of_at: row.as_of_at, total_value_cents: Number(row.total_value_cents) }
    : null;
}
