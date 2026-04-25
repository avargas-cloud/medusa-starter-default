/**
 * PurchasingSnapshotService
 *
 * Orchestrates DailySalesEngine + ParetoEngine and writes results to
 * purchasing_snapshot.  Called by the cron job and the recalculate API.
 *
 * Flow:
 *   1. Load all active product variants
 *   2. Load all active alternative relationships
 *   3. Load current inventory per variant (USA + China)
 *   4. For each variant: calculate daily sales (primary + alts combined)
 *   5. Run Pareto engine across all variants
 *   6. Calculate qty_to_transfer / qty_to_factory
 *   7. Upsert purchasing_snapshot rows
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import { loadPurchasingConfig } from "./purchasing-config.service";
import { calculateDailySales } from "./daily-sales-engine";
import { runParetoEngine, VariantForPareto } from "./pareto-engine";

dotenv.config();

const USA_LOC   = process.env.ECOPOWERTECH_MIAMI_LOCATION_ID  ?? "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC = process.env.CHINA_WAREHOUSE_LOCATION_ID     ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

export interface SnapshotRunResult {
  processed: number;
  errors: number;
  durationMs: number;
}

export async function runPurchasingSnapshot(): Promise<SnapshotRunResult> {
  const start = Date.now();
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  let processed = 0;
  let errors = 0;

  try {
    const cfg = await loadPurchasingConfig(db);

    // ── 1. All active variants ─────────────────────────────────────────────
    const varRes = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE deleted_at IS NULL ORDER BY sku`
    );
    const allVariants = varRes.rows;

    // ── 2. All active alternative relationships ────────────────────────────
    const altRes = await db.query<{
      primary_variant_id: string;
      alt_variant_id: string;
    }>(
      `SELECT primary_variant_id, alt_variant_id
       FROM product_alternative
       WHERE is_active = true AND deleted_at IS NULL`
    );

    const altsByPrimary = new Map<string, string[]>();
    for (const row of altRes.rows) {
      const existing = altsByPrimary.get(row.primary_variant_id) ?? [];
      existing.push(row.alt_variant_id);
      altsByPrimary.set(row.primary_variant_id, existing);
    }

    // ── 3. Current inventory ───────────────────────────────────────────────
    const invRes = await db.query<{
      variant_id: string;
      inv_usa: string;
      inv_china: string;
    }>(
      `SELECT
         pvii.variant_id,
         COALESCE(SUM(CASE WHEN il.location_id = $1 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_usa,
         COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_china
       FROM product_variant_inventory_item pvii
       JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
       JOIN inventory_level il ON il.inventory_item_id = ii.id
         AND il.location_id IN ($1, $2) AND il.deleted_at IS NULL
       GROUP BY pvii.variant_id`,
      [USA_LOC, CHINA_LOC]
    );
    const invByVariant = new Map<string, { usa: number; china: number }>();
    for (const row of invRes.rows) {
      invByVariant.set(row.variant_id, {
        usa: Number(row.inv_usa),
        china: Number(row.inv_china),
      });
    }

    // ── 4. Calculate daily sales per variant ──────────────────────────────
    type CalcResult = {
      variant_id: string;
      tier0_30d: number;
      sales_q1: number;
      sales_q2: number;
      sales_q3: number;
      sales_q4: number;
      daily_sales_est: number;
      monthly_sales_est: number;
      cv: number;
      revenue_12m: number;
    };

    const results: CalcResult[] = [];

    for (const v of allVariants) {
      try {
        const alts = altsByPrimary.get(v.id) ?? [];
        const sales = await calculateDailySales(db, v.id, alts, cfg);

        // 12-month revenue for Pareto (sum of quarterly sales × avg price)
        // Simple approximation: use sales history revenue directly
        const revRes = await db.query<{ total_revenue: string }>(
          `SELECT COALESCE(SUM(revenue), 0)::numeric AS total_revenue
           FROM purchasing_sales_history
           WHERE variant_id = ANY($1::text[])
             AND month_date >= (NOW() - INTERVAL '12 months')::date`,
          [[v.id, ...alts]]
        );
        const revenue_12m = parseFloat(revRes.rows[0]?.total_revenue ?? "0");

        results.push({ variant_id: v.id, ...sales, revenue_12m });
      } catch (e) {
        errors++;
        console.error(`[snapshot] Error for variant ${v.id}: ${(e as Error).message}`);
      }
    }

    // ── 5. Run Pareto engine ───────────────────────────────────────────────
    const paretoInput: VariantForPareto[] = results.map((r) => ({
      variant_id: r.variant_id,
      revenue_12m: r.revenue_12m,
      cv: r.cv,
    }));
    const paretoResults = runParetoEngine(paretoInput, cfg);
    const paretoMap = new Map(paretoResults.map((p) => [p.variant_id, p]));

    // ── 6 + 7. Calculate reorder quantities and upsert ────────────────────
    for (const r of results) {
      try {
        const pareto = paretoMap.get(r.variant_id);
        const inv = invByVariant.get(r.variant_id) ?? { usa: 0, china: 0 };

        // Alt inventory (USA only — offsets reorder need)
        const alts = altsByPrimary.get(r.variant_id) ?? [];
        let altInvUsa = 0;
        for (const altId of alts) {
          altInvUsa += invByVariant.get(altId)?.usa ?? 0;
        }

        const leadAir = cfg.transit_air_days + cfg.buffer_air_days;
        const leadSea = cfg.transit_sea_days + cfg.buffer_sea_days;

        const qty_to_transfer = Math.max(
          0,
          Math.round(r.daily_sales_est * leadAir - inv.usa - altInvUsa)
        );
        const qty_to_factory = Math.max(
          0,
          Math.round(r.daily_sales_est * leadSea - inv.china)
        );

        const id = `psnap_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

        await db.query(
          `INSERT INTO purchasing_snapshot
             (id, variant_id,
              tier0_30d, sales_q1, sales_q2, sales_q3, sales_q4,
              daily_sales_est, monthly_sales_est, cv,
              abc_class, xyz_class, abcxyz_class,
              inv_usa, inv_china, qty_to_transfer, qty_to_factory,
              last_calculated_at, created_at, updated_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              $14, $15, $16, $17, now(), now(), now())
           ON CONFLICT (variant_id)
           DO UPDATE SET
             tier0_30d         = EXCLUDED.tier0_30d,
             sales_q1          = EXCLUDED.sales_q1,
             sales_q2          = EXCLUDED.sales_q2,
             sales_q3          = EXCLUDED.sales_q3,
             sales_q4          = EXCLUDED.sales_q4,
             daily_sales_est   = EXCLUDED.daily_sales_est,
             monthly_sales_est = EXCLUDED.monthly_sales_est,
             cv                = EXCLUDED.cv,
             abc_class         = EXCLUDED.abc_class,
             xyz_class         = EXCLUDED.xyz_class,
             abcxyz_class      = EXCLUDED.abcxyz_class,
             inv_usa           = EXCLUDED.inv_usa,
             inv_china         = EXCLUDED.inv_china,
             qty_to_transfer   = EXCLUDED.qty_to_transfer,
             qty_to_factory    = EXCLUDED.qty_to_factory,
             last_calculated_at = now(),
             updated_at        = now()`,
          [
            id, r.variant_id,
            r.tier0_30d, r.sales_q1, r.sales_q2, r.sales_q3, r.sales_q4,
            r.daily_sales_est, r.monthly_sales_est, r.cv,
            pareto?.abc_class ?? null,
            pareto?.xyz_class ?? null,
            pareto?.abcxyz_class ?? null,
            inv.usa, inv.china,
            qty_to_transfer, qty_to_factory,
          ]
        );
        processed++;
      } catch (e) {
        errors++;
        console.error(`[snapshot] Upsert error for ${r.variant_id}: ${(e as Error).message}`);
      }
    }

    return { processed, errors, durationMs: Date.now() - start };
  } finally {
    await db.end();
  }
}
