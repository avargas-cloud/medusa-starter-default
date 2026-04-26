/**
 * PurchasingSnapshotService
 *
 * Performance design:
 *   • ALL data loaded in bulk (6 queries total, not 2× per variant).
 *   • calculateDailySales is synchronous/pure — no DB calls in the variant loop.
 *   • Skip upsert when computed values match stored values (no-op run = near-instant).
 *   • Batch upsert in chunks of 200 rows to avoid huge query strings.
 *
 * Full run flow:
 *   1. Load config + build engine context (tier0 window, biz days, all tier0 totals, all history)
 *   2. Load variants, alt relationships, inventory (bulk)
 *   3. Load revenue_12m per variant (bulk)
 *   4. Load current snapshot rows for change detection (bulk)
 *   5. For each variant: pure RAM calculation
 *   6. Run Pareto engine
 *   7. Batch upsert only changed rows
 */

import * as dotenv from "dotenv";
import { Client } from "pg";

import {
  buildSalesEngineContext,
  calculateDailySales,
} from "./daily-sales-engine";
import { runParetoEngine, VariantForPareto } from "./pareto-engine";
import { loadPurchasingConfig } from "./purchasing-config.service";

dotenv.config();

const USA_LOC =
  process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ??
  "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

export interface SnapshotRunResult {
  processed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

const UPSERT_BATCH = 200;

function approxEq(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) <= eps;
}

export async function runPurchasingSnapshot(): Promise<SnapshotRunResult> {
  const start = Date.now();
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // ── 1. Config + engine context (bulk: biz days + tier0 totals + history) ─
    const cfg = await loadPurchasingConfig(db);
    const engineCtx = await buildSalesEngineContext(db);

    // ── 2. Variants, alt relationships, inventory, open POs, vendor prod days ─
    const [varRes, altRes, invRes, poRes, vendorRes] = await Promise.all([
      db.query<{ id: string; sku: string }>(
        `SELECT id, sku FROM product_variant WHERE deleted_at IS NULL ORDER BY sku`
      ),
      db.query<{ primary_variant_id: string; alt_variant_id: string }>(
        `SELECT primary_variant_id, alt_variant_id
         FROM product_alternative
         WHERE is_active = true AND deleted_at IS NULL`
      ),
      db.query<{ variant_id: string; inv_usa: string; inv_china: string }>(
        `SELECT pvii.variant_id,
                COALESCE(SUM(CASE WHEN il.location_id = $1 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_usa,
                COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_china
         FROM product_variant_inventory_item pvii
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = ii.id
           AND il.location_id IN ($1, $2) AND il.deleted_at IS NULL
         GROUP BY pvii.variant_id`,
        [USA_LOC, CHINA_LOC]
      ),
      db.query<{ sku: string; on_order: string }>(
        `SELECT pol.sku_snapshot AS sku,
                SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)) AS on_order
         FROM purchase_order_line pol
         JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
         WHERE po.status IN ('submitted', 'partially_received')
           AND pol.status IN ('open', 'partial')
           AND pol.deleted_at IS NULL
         GROUP BY pol.sku_snapshot`
      ),
      db.query<{ variant_id: string; production_days: string }>(
        `SELECT lnk.product_variant_id AS variant_id,
                COALESCE((qv.metadata->>'production_days')::int, 10) AS production_days
         FROM quickbooks_catalog_qb_vendor_product_product_variant lnk
         JOIN qb_vendor qv ON qv.id = lnk.qb_vendor_id
         WHERE lnk.deleted_at IS NULL`
      ),
    ]);

    const allVariants = varRes.rows;

    const altsByPrimary = new Map<string, string[]>();
    for (const row of altRes.rows) {
      const list = altsByPrimary.get(row.primary_variant_id) ?? [];
      list.push(row.alt_variant_id);
      altsByPrimary.set(row.primary_variant_id, list);
    }

    const invByVariant = new Map(
      invRes.rows.map((r) => [
        r.variant_id,
        { usa: Number(r.inv_usa), china: Number(r.inv_china) },
      ])
    );
    const skuByVariant = new Map(varRes.rows.map((r) => [r.id, r.sku]));

    // sku → open PO quantity
    const poBySkuMap = new Map(
      poRes.rows.map((r) => [r.sku, Number(r.on_order)])
    );

    // variant_id → production days from vendor metadata (fallback 10 days)
    const prodDaysByVariant = new Map(
      vendorRes.rows.map((r) => [r.variant_id, Number(r.production_days)])
    );

    // ── 3. Revenue 12m per variant (bulk) ──────────────────────────────────
    const revRes = await db.query<{
      variant_id: string;
      total_revenue: string;
    }>(
      `SELECT variant_id, COALESCE(SUM(revenue), 0)::text AS total_revenue
       FROM purchasing_sales_history
       WHERE month_date >= (NOW() - INTERVAL '12 months')::date
       GROUP BY variant_id`
    );
    const revByVariant = new Map(
      revRes.rows.map((r) => [r.variant_id, parseFloat(r.total_revenue)])
    );

    // ── 4. Smart skip detection ────────────────────────────────────────────
    // Same-day re-run: skip variants with no new orders since last calculation.
    // New day: always recalculate all (biz-day denominator changed).
    const snapRes = await db.query<{
      variant_id: string;
      last_calculated_at: string;
      tier0_30d: string;
      sales_q1: string;
      sales_q2: string;
      sales_q3: string;
      sales_q4: string;
      sales_last_24d: string;
      daily_sales_est: string;
      monthly_sales_est: string;
      cv: string;
      inv_usa: string;
      inv_china: string;
    }>(
      `SELECT variant_id, last_calculated_at,
              tier0_30d, sales_q1, sales_q2, sales_q3, sales_q4,
              sales_last_24d,
              daily_sales_est, monthly_sales_est, cv, inv_usa, inv_china
       FROM purchasing_snapshot`
    );

    // Is this a same-day re-run?
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const minLastCalc =
      snapRes.rows.length > 0
        ? snapRes.rows.reduce<string>(
            (min, r) =>
              r.last_calculated_at < min ? r.last_calculated_at : min,
            snapRes.rows[0]!.last_calculated_at
          )
        : null;
    const lastRunDateET = minLastCalc
      ? new Date(minLastCalc).toLocaleDateString("en-CA", {
          timeZone: "America/New_York",
        })
      : null;
    const isSameDayRun = lastRunDateET === todayET;

    // For same-day runs: find which variant_ids have new/changed orders since last run
    let changedVariantIds: Set<string> | null = null;
    if (isSameDayRun && minLastCalc) {
      const changedRes = await db.query<{ variant_id: string }>(
        `SELECT DISTINCT pii.variant_id
         FROM pos_invoice_item pii
         JOIN pos_invoice pi ON pi.id = pii.invoice_id
         WHERE (pi.created_at > $1 OR pi.updated_at > $1)
           AND pi.status NOT IN ('voided')
           AND pii.deleted_at IS NULL
           AND pii.variant_id IS NOT NULL`,
        [minLastCalc]
      );
      changedVariantIds = new Set(changedRes.rows.map((r) => r.variant_id));
    }

    type SnapRow = {
      tier0_30d: number;
      sales_q1: number;
      sales_q2: number;
      sales_q3: number;
      sales_q4: number;
      sales_last_24d: number;
      daily_sales_est: number;
      monthly_sales_est: number;
      cv: number;
      inv_usa: number;
      inv_china: number;
    };
    const currentSnap = new Map<string, SnapRow>(
      snapRes.rows.map((r) => [
        r.variant_id,
        {
          tier0_30d: parseFloat(r.tier0_30d),
          sales_q1: parseFloat(r.sales_q1),
          sales_q2: parseFloat(r.sales_q2),
          sales_q3: parseFloat(r.sales_q3),
          sales_q4: parseFloat(r.sales_q4),
          sales_last_24d: parseFloat(r.sales_last_24d),
          daily_sales_est: parseFloat(r.daily_sales_est),
          monthly_sales_est: parseFloat(r.monthly_sales_est),
          cv: parseFloat(r.cv),
          inv_usa: parseFloat(r.inv_usa),
          inv_china: parseFloat(r.inv_china),
        },
      ])
    );

    // ── 5. Pure RAM calculation per variant ───────────────────────────────
    type CalcResult = {
      variant_id: string;
      tier0_30d: number;
      sales_q1: number;
      sales_q2: number;
      sales_q3: number;
      sales_q4: number;
      sales_last_24d: number;
      daily_sales_est: number;
      monthly_sales_est: number;
      cv: number;
      revenue_12m: number;
      inv_usa: number;
      inv_china: number;
    };

    const results: CalcResult[] = [];

    for (const v of allVariants) {
      try {
        const alts = altsByPrimary.get(v.id) ?? [];

        // ── Smart skip (same-day run, no new orders for this variant or alts) ─
        if (changedVariantIds !== null) {
          const relevantIds = [v.id, ...alts];
          const hasChange = relevantIds.some((id) =>
            changedVariantIds!.has(id)
          );
          if (!hasChange) {
            skipped++;
            continue;
          }
        }

        const sales = calculateDailySales(v.id, alts, cfg, engineCtx);
        const inv = invByVariant.get(v.id) ?? { usa: 0, china: 0 };

        // Revenue: sum primary + alts
        const revenue_12m = [v.id, ...alts].reduce(
          (s, id) => s + (revByVariant.get(id) ?? 0),
          0
        );

        // Secondary skip: new-day run but values unchanged (e.g. zero-sales variant)
        if (changedVariantIds === null) {
          const cur = currentSnap.get(v.id);
          if (
            cur &&
            approxEq(cur.tier0_30d, sales.tier0_30d) &&
            approxEq(cur.sales_q1, sales.sales_q1) &&
            approxEq(cur.sales_q2, sales.sales_q2) &&
            approxEq(cur.sales_q3, sales.sales_q3) &&
            approxEq(cur.sales_q4, sales.sales_q4) &&
            approxEq(cur.daily_sales_est, sales.daily_sales_est) &&
            approxEq(cur.inv_usa, inv.usa) &&
            approxEq(cur.inv_china, inv.china)
          ) {
            skipped++;
            continue;
          }
        }

        results.push({
          variant_id: v.id,
          ...sales,
          revenue_12m,
          inv_usa: inv.usa,
          inv_china: inv.china,
        });
      } catch (e) {
        errors++;
        console.error(
          `[snapshot] Error for variant ${v.id}: ${(e as Error).message}`
        );
      }
    }

    // ── 6. Run Pareto engine ───────────────────────────────────────────────
    const paretoInput: VariantForPareto[] = results.map((r) => ({
      variant_id: r.variant_id,
      revenue_12m: r.revenue_12m,
      cv: r.cv,
    }));
    const paretoResults = runParetoEngine(paretoInput, cfg);
    const paretoMap = new Map(paretoResults.map((p) => [p.variant_id, p]));

    // ── 7. Batch upsert changed rows ───────────────────────────────────────
    const leadAir = cfg.transit_air_days + cfg.buffer_air_days;

    for (let i = 0; i < results.length; i += UPSERT_BATCH) {
      const batch = results.slice(i, i + UPSERT_BATCH);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;

      for (const r of batch) {
        const pareto = paretoMap.get(r.variant_id);
        const alts = altsByPrimary.get(r.variant_id) ?? [];
        const altInvUsa = alts.reduce(
          (s, id) => s + (invByVariant.get(id)?.usa ?? 0),
          0
        );
        const sku = skuByVariant.get(r.variant_id) ?? "";
        const onOrder = poBySkuMap.get(sku) ?? 0;

        const abcClass = pareto?.abc_class ?? "C";
        const factoryMult =
          abcClass === "A" ? 1.0 : abcClass === "B" ? 0.7 : 0.5;
        const prodDays = prodDaysByVariant.get(r.variant_id) ?? 10;
        const effectiveDays = Math.round(prodDays * factoryMult);

        const qty_to_transfer = Math.max(
          0,
          Math.round(
            r.daily_sales_est * leadAir - r.inv_usa - altInvUsa - onOrder
          )
        );
        const qty_to_factory = Math.max(
          0,
          Math.round(r.daily_sales_est * effectiveDays - r.inv_china)
        );
        const id = `psnap_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

        values.push(
          id,
          r.variant_id,
          r.tier0_30d,
          r.sales_q1,
          r.sales_q2,
          r.sales_q3,
          r.sales_q4,
          r.sales_last_24d,
          r.daily_sales_est,
          r.monthly_sales_est,
          r.cv,
          pareto?.abc_class ?? null,
          pareto?.xyz_class ?? null,
          pareto?.abcxyz_class ?? null,
          r.inv_usa,
          r.inv_china,
          qty_to_transfer,
          qty_to_factory,
          prodDays
        );
        placeholders.push(
          `($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14},$${p + 15},$${p + 16},$${p + 17},$${p + 18},now(),now(),now())`
        );
        p += 19;
      }

      try {
        await db.query(
          `INSERT INTO purchasing_snapshot
             (id,variant_id,tier0_30d,sales_q1,sales_q2,sales_q3,sales_q4,
              sales_last_24d,
              daily_sales_est,monthly_sales_est,cv,
              abc_class,xyz_class,abcxyz_class,
              inv_usa,inv_china,qty_to_transfer,qty_to_factory,production_days,
              last_calculated_at,created_at,updated_at)
           VALUES ${placeholders.join(",")}
           ON CONFLICT (variant_id) DO UPDATE SET
             tier0_30d=EXCLUDED.tier0_30d, sales_q1=EXCLUDED.sales_q1,
             sales_q2=EXCLUDED.sales_q2, sales_q3=EXCLUDED.sales_q3,
             sales_q4=EXCLUDED.sales_q4,
             sales_last_24d=EXCLUDED.sales_last_24d,
             daily_sales_est=EXCLUDED.daily_sales_est,
             monthly_sales_est=EXCLUDED.monthly_sales_est,
             cv=EXCLUDED.cv,
             abc_class=EXCLUDED.abc_class, xyz_class=EXCLUDED.xyz_class,
             abcxyz_class=EXCLUDED.abcxyz_class,
             inv_usa=EXCLUDED.inv_usa, inv_china=EXCLUDED.inv_china,
             qty_to_transfer=EXCLUDED.qty_to_transfer,
             qty_to_factory=EXCLUDED.qty_to_factory,
             production_days=EXCLUDED.production_days,
             last_calculated_at=now(), updated_at=now()`,
          values
        );
        processed += batch.length;
      } catch (e) {
        errors += batch.length;
        console.error(`[snapshot] Batch upsert error: ${(e as Error).message}`);
      }
    }

    return { processed, skipped, errors, durationMs: Date.now() - start };
  } finally {
    await db.end();
  }
}

// ── Targeted recalculation for a subset of variants ───────────────────────────

export async function recalculateForVariants(
  variantIds: string[]
): Promise<void> {
  if (variantIds.length === 0) return;

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const cfg = await loadPurchasingConfig(db);
    const engineCtx = await buildSalesEngineContext(db);

    const altRes = await db.query<{
      primary_variant_id: string;
      alt_variant_id: string;
    }>(
      `SELECT primary_variant_id, alt_variant_id
       FROM product_alternative
       WHERE (primary_variant_id = ANY($1::text[]) OR alt_variant_id = ANY($1::text[]))
         AND is_active = true AND deleted_at IS NULL`,
      [variantIds]
    );
    const altsByPrimary = new Map<string, string[]>();
    for (const row of altRes.rows) {
      const list = altsByPrimary.get(row.primary_variant_id) ?? [];
      list.push(row.alt_variant_id);
      altsByPrimary.set(row.primary_variant_id, list);
    }

    const allIds = [
      ...new Set([...variantIds, ...altRes.rows.map((r) => r.alt_variant_id)]),
    ];

    // Look up SKUs for the variant IDs being recalculated (needed for PO query)
    const skuRes = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [allIds]
    );
    const skuByVariant = new Map(skuRes.rows.map((r) => [r.id, r.sku]));
    const skusForPo = [
      ...new Set(skuRes.rows.map((r) => r.sku).filter(Boolean)),
    ];

    const [invRes, vendorPartialRes, snapPartialRes, poPartialRes] =
      await Promise.all([
        db.query<{ variant_id: string; inv_usa: string; inv_china: string }>(
          `SELECT pvii.variant_id,
                COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_usa,
                COALESCE(SUM(CASE WHEN il.location_id = $3 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_china
         FROM product_variant_inventory_item pvii
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = ii.id
           AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
         WHERE pvii.variant_id = ANY($1::text[])
         GROUP BY pvii.variant_id`,
          [allIds, USA_LOC, CHINA_LOC]
        ),
        db.query<{ variant_id: string; production_days: string }>(
          `SELECT lnk.product_variant_id AS variant_id,
                COALESCE((qv.metadata->>'production_days')::int, 10) AS production_days
         FROM quickbooks_catalog_qb_vendor_product_product_variant lnk
         JOIN qb_vendor qv ON qv.id = lnk.qb_vendor_id
         WHERE lnk.product_variant_id = ANY($1::text[]) AND lnk.deleted_at IS NULL`,
          [allIds]
        ),
        db.query<{ variant_id: string; abc_class: string | null }>(
          `SELECT variant_id, abc_class FROM purchasing_snapshot WHERE variant_id = ANY($1::text[])`,
          [variantIds]
        ),
        db.query<{ sku: string; on_order: string }>(
          `SELECT pol.sku_snapshot AS sku,
                SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)) AS on_order
         FROM purchase_order_line pol
         JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
         WHERE po.status IN ('submitted', 'partially_received')
           AND pol.status IN ('open', 'partial')
           AND pol.deleted_at IS NULL
           AND pol.sku_snapshot = ANY($1::text[])
         GROUP BY pol.sku_snapshot`,
          [skusForPo]
        ),
      ]);

    const invByVariant = new Map(
      invRes.rows.map((r) => [
        r.variant_id,
        { usa: Number(r.inv_usa), china: Number(r.inv_china) },
      ])
    );
    const prodDaysPartial = new Map(
      vendorPartialRes.rows.map((r) => [
        r.variant_id,
        Number(r.production_days),
      ])
    );
    const abcClassPartial = new Map(
      snapPartialRes.rows.map((r) => [r.variant_id, r.abc_class])
    );
    const poBySkuMap = new Map(
      poPartialRes.rows.map((r) => [r.sku, Number(r.on_order)])
    );

    const leadAirPartial = cfg.transit_air_days + cfg.buffer_air_days;

    for (const variantId of variantIds) {
      try {
        const alts = altsByPrimary.get(variantId) ?? [];
        const sales = calculateDailySales(variantId, alts, cfg, engineCtx);
        const inv = invByVariant.get(variantId) ?? { usa: 0, china: 0 };
        let altInvUsa = 0;
        for (const altId of alts)
          altInvUsa += invByVariant.get(altId)?.usa ?? 0;

        const abcClass = abcClassPartial.get(variantId) ?? "C";
        const factoryMult =
          abcClass === "A" ? 1.0 : abcClass === "B" ? 0.7 : 0.5;
        const prodDays = prodDaysPartial.get(variantId) ?? 10;
        const effectiveDays = Math.round(prodDays * factoryMult);

        const sku = skuByVariant.get(variantId) ?? "";
        const onOrder = poBySkuMap.get(sku) ?? 0;
        const qty_to_transfer = Math.max(
          0,
          Math.round(
            sales.daily_sales_est * leadAirPartial -
              inv.usa -
              altInvUsa -
              onOrder
          )
        );
        const qty_to_factory = Math.max(
          0,
          Math.round(sales.daily_sales_est * effectiveDays - inv.china)
        );

        await db.query(
          `UPDATE purchasing_snapshot
           SET tier0_30d=$2, sales_q1=$3, sales_q2=$4, sales_q3=$5, sales_q4=$6,
               daily_sales_est=$7, monthly_sales_est=$8, cv=$9,
               inv_usa=$10, inv_china=$11,
               qty_to_transfer=$12, qty_to_factory=$13, production_days=$14,
               last_calculated_at=now(), updated_at=now()
           WHERE variant_id=$1`,
          [
            variantId,
            sales.tier0_30d,
            sales.sales_q1,
            sales.sales_q2,
            sales.sales_q3,
            sales.sales_q4,
            sales.daily_sales_est,
            sales.monthly_sales_est,
            sales.cv,
            inv.usa,
            inv.china,
            qty_to_transfer,
            qty_to_factory,
            prodDays,
          ]
        );
      } catch (e) {
        console.error(
          `[snapshot/partial] Error for ${variantId}: ${(e as Error).message}`
        );
      }
    }
  } finally {
    await db.end();
  }
}
