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

import { USA_LOC, CHINA_LOC } from "../../lib/locations";

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

/**
 * Factory (manufacturing) days multiplier for an ABC class. Configurable via
 * purchasing_config (factory_mult_a/b/c). Defaults 1.0 / 0.7 / 0.5.
 */
function factoryMultFor(
  cfg: Pick<
    import("./purchasing-config.service").PurchasingConfig,
    "factory_mult_a" | "factory_mult_b" | "factory_mult_c"
  >,
  abcClass: string
): number {
  return abcClass === "A"
    ? cfg.factory_mult_a
    : abcClass === "B"
      ? cfg.factory_mult_b
      : cfg.factory_mult_c;
}

export interface SnapshotRunOptions {
  /**
   * Bypass smart-skip logic and recompute every variant. Use after algorithm
   * changes (e.g. ABC threshold/grouping changes) so existing rows align
   * with the new calculation.
   */
  force?: boolean;
}

export async function runPurchasingSnapshot(
  opts: SnapshotRunOptions = {}
): Promise<SnapshotRunResult> {
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
    const [varRes, altRes, invRes, poRes, vendorRes, sourcedRes, chinaShippedRes] =
      await Promise.all([
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
                COALESCE(SUM(CASE WHEN il.location_id = $2 THEN GREATEST(0, il.stocked_quantity - il.reserved_quantity) ELSE 0 END), 0) AS inv_china
         FROM product_variant_inventory_item pvii
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = ii.id
           AND il.location_id IN ($1, $2) AND il.deleted_at IS NULL
         GROUP BY pvii.variant_id`,
        [USA_LOC, CHINA_LOC]
      ),
      db.query<{ sku: string; on_order_usa: string; on_order_china: string }>(
        `SELECT sku, SUM(on_order_usa) AS on_order_usa, SUM(on_order_china) AS on_order_china
         FROM (
           SELECT pol.sku_snapshot AS sku,
                  CASE WHEN BTRIM(po.stock_location_id, E' \\t\\n\\r') = $1
                       THEN GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)
                       ELSE 0 END AS on_order_usa,
                  CASE WHEN BTRIM(po.stock_location_id, E' \\t\\n\\r') = $2
                       THEN GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)
                       ELSE 0 END AS on_order_china
           FROM purchase_order_line pol
           JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
           WHERE po.status IN ('submitted', 'partially_received')
             AND pol.status IN ('open', 'partial')
             AND pol.deleted_at IS NULL
           UNION ALL
           SELECT fol.sku_snapshot AS sku,
                  0 AS on_order_usa,
                  CASE WHEN BTRIM(fo.stock_location_id, E' \\t\\n\\r') = $2
                       THEN GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled)
                       ELSE 0 END AS on_order_china
           FROM factory_order_line fol
           JOIN factory_order fo ON fo.id = fol.factory_order_id AND fo.deleted_at IS NULL
           WHERE fo.status IN ('submitted', 'partially_received')
             AND fol.status IN ('open', 'partial')
             AND fol.deleted_at IS NULL
         ) combined
         GROUP BY sku`,
        [USA_LOC, CHINA_LOC]
      ),
      db.query<{ variant_id: string; production_days: string }>(
        `SELECT pv.id AS variant_id,
                COALESCE((qv.metadata->>'production_days')::int, 10) AS production_days
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
         JOIN qb_vendor qv ON qv.qb_list_id = (p.metadata->>'qb_vendor_list_id')
           AND qv.deleted_at IS NULL
         WHERE pv.deleted_at IS NULL
           AND p.metadata->>'qb_vendor_list_id' IS NOT NULL`
      ),
      // Variants whose product is sourced from China (via Veetech agent).
      // Non-sourced variants skip ALL China-supply calc (inv, alt inv, PO, alt PO,
      // qty_to_factory) — they have no China supply chain to consider.
      db.query<{ variant_id: string }>(
        `SELECT pv.id AS variant_id
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
         WHERE pv.deleted_at IS NULL
           AND COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) = true`
      ),
      // Units currently in transit from China (IT.status='shipped', not yet received).
      // inv_china_available = stocked_quantity - china_shipped
      db.query<{ variant_id: string; china_shipped: string }>(
        `SELECT itl.product_variant_id AS variant_id,
                SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))) AS china_shipped
           FROM inventory_transfer_line itl
           JOIN inventory_transfer it ON it.id = itl.transfer_id AND it.deleted_at IS NULL
          WHERE it.status = 'shipped'
            AND it.origin_country = 'CN'
            AND itl.deleted_at IS NULL
          GROUP BY itl.product_variant_id`
      ),
    ]);

    const sourcedFromChina = new Set(
      sourcedRes.rows.map((r) => r.variant_id)
    );

    // variant_id → units currently in transit from China (shipped IT lines)
    const chinaShippedByVariant = new Map(
      chinaShippedRes.rows.map((r) => [r.variant_id, Number(r.china_shipped)])
    );

    const allVariants = varRes.rows;

    const altsByPrimary = new Map<string, string[]>();
    const altSet = new Set<string>();
    for (const row of altRes.rows) {
      const list = altsByPrimary.get(row.primary_variant_id) ?? [];
      list.push(row.alt_variant_id);
      altsByPrimary.set(row.primary_variant_id, list);
      altSet.add(row.alt_variant_id);
    }

    const invByVariant = new Map(
      invRes.rows.map((r) => [
        r.variant_id,
        { usa: Number(r.inv_usa), china: Number(r.inv_china) },
      ])
    );
    const skuByVariant = new Map(varRes.rows.map((r) => [r.id, r.sku]));

    // sku → open PO quantity, split by destination location
    const poUsaBySku = new Map(
      poRes.rows.map((r) => [r.sku, Number(r.on_order_usa)])
    );
    const poChinaBySku = new Map(
      poRes.rows.map((r) => [r.sku, Number(r.on_order_china)])
    );

    // variant_id → production days from vendor metadata (fallback 10 days)
    const prodDaysByVariant = new Map(
      vendorRes.rows.map((r) => [r.variant_id, Number(r.production_days)])
    );

    // ── 3. Revenue 12m per variant (bulk) ──────────────────────────────────
    // qty_sold > 0 mirrors /admin/purchasing/monthly-sales so the Pareto tab
    // and the snapshot rank from the same revenue universe.
    const revRes = await db.query<{
      variant_id: string;
      total_revenue: string;
    }>(
      `SELECT variant_id, COALESCE(SUM(revenue), 0)::text AS total_revenue
       FROM purchasing_sales_history
       WHERE month_date >= (NOW() - INTERVAL '12 months')::date
         AND qty_sold > 0
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
      unmet_net_30d: string;
      daily_sales_est: string;
      monthly_sales_est: string;
      cv: string;
      inv_usa: string;
      inv_china: string;
      inv_china_alt: string;
      qty_on_po_china: string;
      qty_on_po_china_alt: string;
    }>(
      `SELECT variant_id, last_calculated_at,
              tier0_30d, sales_q1, sales_q2, sales_q3, sales_q4,
              sales_last_24d, unmet_net_30d,
              daily_sales_est, monthly_sales_est, cv, inv_usa, inv_china,
              inv_china_alt, qty_on_po_china, qty_on_po_china_alt
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
    if (isSameDayRun && minLastCalc && !opts.force) {
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
      unmet_net_30d: number;
      daily_sales_est: number;
      monthly_sales_est: number;
      cv: number;
      inv_usa: number;
      inv_china: number;
      inv_china_alt: number;
      qty_on_po_china: number;
      qty_on_po_china_alt: number;
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
          unmet_net_30d: parseFloat(r.unmet_net_30d ?? "0"),
          daily_sales_est: parseFloat(r.daily_sales_est),
          monthly_sales_est: parseFloat(r.monthly_sales_est),
          cv: parseFloat(r.cv),
          inv_usa: parseFloat(r.inv_usa),
          inv_china: parseFloat(r.inv_china),
          inv_china_alt: parseFloat(r.inv_china_alt ?? "0"),
          qty_on_po_china: parseFloat(r.qty_on_po_china ?? "0"),
          qty_on_po_china_alt: parseFloat(r.qty_on_po_china_alt ?? "0"),
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
      unmet_net_30d: number;
      daily_sales_est: number;
      monthly_sales_est: number;
      cv: number;
      weighted_revenue: number;
      revenue_12m: number;
      inv_usa: number;
      inv_china: number;
      inv_china_alt: number;
      qty_on_po_china: number;
      qty_on_po_china_alt: number;
      first_sale_date: string | null;
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

        // China supply only matters when product is sourced from China.
        // Non-sourced products skip alt/PO lookups entirely (88% of catalog).
        const isSourcedChina = sourcedFromChina.has(v.id);
        // Subtract in-transit units so inv_china reflects what's actually available
        const chinaShipped = isSourcedChina
          ? (chinaShippedByVariant.get(v.id) ?? 0)
          : 0;
        const invChinaOwn = isSourcedChina ? Math.max(0, inv.china - chinaShipped) : 0;
        const invChinaAlt = isSourcedChina
          ? alts.reduce(
              (s, id) => s + (invByVariant.get(id)?.china ?? 0),
              0
            )
          : 0;
        const ownSku = skuByVariant.get(v.id) ?? "";
        const onPoChina = isSourcedChina
          ? (poChinaBySku.get(ownSku) ?? 0)
          : 0;
        const onPoChinaAlt = isSourcedChina
          ? alts.reduce((s, id) => {
              const altSku = skuByVariant.get(id);
              return s + (altSku ? (poChinaBySku.get(altSku) ?? 0) : 0);
            }, 0)
          : 0;

        // Revenue: sum primary + alts
        const revenue_12m = [v.id, ...alts].reduce(
          (s, id) => s + (revByVariant.get(id) ?? 0),
          0
        );

        // Secondary skip: new-day run but values unchanged (e.g. zero-sales variant)
        if (changedVariantIds === null && !opts.force) {
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
            approxEq(cur.inv_china, invChinaOwn) &&
            approxEq(cur.inv_china_alt, invChinaAlt) &&
            approxEq(cur.qty_on_po_china, onPoChina) &&
            approxEq(cur.qty_on_po_china_alt, onPoChinaAlt) &&
            approxEq(cur.unmet_net_30d, sales.unmet_net_30d)
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
          inv_china: invChinaOwn,
          inv_china_alt: invChinaAlt,
          qty_on_po_china: onPoChina,
          qty_on_po_china_alt: onPoChinaAlt,
        });
      } catch (e) {
        errors++;
        console.error(
          `[snapshot] Error for variant ${v.id}: ${(e as Error).message}`
        );
      }
    }

    // ── 6. Run Pareto engine ───────────────────────────────────────────────
    // Only primaries are ranked — alts inherit a fixed "B" fallback so they
    // don't compete in the cumulative-revenue ladder. This matches the
    // /80-20 Pareto tab, which is the source of truth.
    const paretoInput: VariantForPareto[] = results
      .filter((r) => !altSet.has(r.variant_id))
      .map((r) => ({
        variant_id: r.variant_id,
        revenue: r.weighted_revenue,
        cv: r.cv,
      }));
    const paretoResults = runParetoEngine(paretoInput, cfg);
    const paretoMap = new Map(paretoResults.map((p) => [p.variant_id, p]));

    function classFor(variantId: string, cv: number) {
      if (altSet.has(variantId)) {
        const xyz: "X" | "Y" | "Z" =
          cv < cfg.xyz_x_threshold ? "X" : cv < cfg.xyz_y_threshold ? "Y" : "Z";
        return {
          abc_class: "B" as const,
          xyz_class: xyz,
          abcxyz_class: `B${xyz}`,
          pareto_rank: null as number | null,
        };
      }
      return paretoMap.get(variantId) ?? null;
    }

    // ── 7. Batch upsert changed rows ───────────────────────────────────────
    const leadAir = cfg.transit_air_days + cfg.buffer_air_days;

    for (let i = 0; i < results.length; i += UPSERT_BATCH) {
      const batch = results.slice(i, i + UPSERT_BATCH);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;

      for (const r of batch) {
        const pareto = classFor(r.variant_id, r.cv);
        const alts = altsByPrimary.get(r.variant_id) ?? [];
        const altInvUsa = alts.reduce(
          (s, id) => s + (invByVariant.get(id)?.usa ?? 0),
          0
        );
        const sku = skuByVariant.get(r.variant_id) ?? "";
        const onPoUsa = poUsaBySku.get(sku) ?? 0;

        const abcClass = pareto?.abc_class ?? "C";
        const factoryMult = factoryMultFor(cfg, abcClass);
        const prodDays = prodDaysByVariant.get(r.variant_id) ?? 10;
        const effectiveDays = Math.round(prodDays * factoryMult);

        const qty_to_transfer = Math.max(
          0,
          Math.round(
            r.daily_sales_est * leadAir - r.inv_usa - altInvUsa - onPoUsa
          )
        );
        // Factory order only applies to China-sourced products. For non-sourced
        // ones, all China supply fields are already 0 (zeroed in the calc loop)
        // and qty_to_factory is forced to 0 — no factory PO ever generated.
        const isSourcedChina = sourcedFromChina.has(r.variant_id);
        const supplyChina = isSourcedChina
          ? r.inv_china +
            r.inv_china_alt +
            r.qty_on_po_china +
            r.qty_on_po_china_alt
          : 0;
        const qty_to_factory = isSourcedChina
          ? Math.max(
              0,
              Math.round(r.daily_sales_est * effectiveDays - supplyChina)
            )
          : 0;
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
          r.unmet_net_30d ?? 0,
          r.daily_sales_est,
          r.monthly_sales_est,
          r.cv,
          r.weighted_revenue,
          pareto?.pareto_rank ?? null,
          pareto?.abc_class ?? null,
          pareto?.xyz_class ?? null,
          pareto?.abcxyz_class ?? null,
          r.inv_usa,
          r.inv_china,
          r.inv_china_alt,
          r.qty_on_po_china,
          r.qty_on_po_china_alt,
          qty_to_transfer,
          qty_to_factory,
          prodDays,
          r.first_sale_date
        );
        const cols = 26;
        const ph = Array.from({ length: cols }, (_, k) => `$${p + k}`).join(",");
        placeholders.push(`(${ph},now(),now(),now())`);
        p += cols;
      }

      try {
        await db.query(
          `INSERT INTO purchasing_snapshot
             (id,variant_id,tier0_30d,sales_q1,sales_q2,sales_q3,sales_q4,
              sales_last_24d,unmet_net_30d,
              daily_sales_est,monthly_sales_est,cv,
              weighted_revenue,pareto_rank,
              abc_class,xyz_class,abcxyz_class,
              inv_usa,inv_china,inv_china_alt,
              qty_on_po_china,qty_on_po_china_alt,
              qty_to_transfer,qty_to_factory,production_days,
              first_sale_date,
              last_calculated_at,created_at,updated_at)
           VALUES ${placeholders.join(",")}
           ON CONFLICT (variant_id) DO UPDATE SET
             tier0_30d=EXCLUDED.tier0_30d, sales_q1=EXCLUDED.sales_q1,
             sales_q2=EXCLUDED.sales_q2, sales_q3=EXCLUDED.sales_q3,
             sales_q4=EXCLUDED.sales_q4,
             sales_last_24d=EXCLUDED.sales_last_24d,
             unmet_net_30d=EXCLUDED.unmet_net_30d,
             daily_sales_est=EXCLUDED.daily_sales_est,
             monthly_sales_est=EXCLUDED.monthly_sales_est,
             cv=EXCLUDED.cv,
             weighted_revenue=EXCLUDED.weighted_revenue,
             pareto_rank=EXCLUDED.pareto_rank,
             abc_class=EXCLUDED.abc_class, xyz_class=EXCLUDED.xyz_class,
             abcxyz_class=EXCLUDED.abcxyz_class,
             inv_usa=EXCLUDED.inv_usa, inv_china=EXCLUDED.inv_china,
             inv_china_alt=EXCLUDED.inv_china_alt,
             qty_on_po_china=EXCLUDED.qty_on_po_china,
             qty_on_po_china_alt=EXCLUDED.qty_on_po_china_alt,
             qty_to_transfer=EXCLUDED.qty_to_transfer,
             qty_to_factory=EXCLUDED.qty_to_factory,
             production_days=EXCLUDED.production_days,
             first_sale_date=EXCLUDED.first_sale_date,
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

    const [invRes, vendorPartialRes, snapPartialRes, poPartialRes, sourcedPartialRes] =
      await Promise.all([
        db.query<{ variant_id: string; inv_usa: string; inv_china: string }>(
          `SELECT pvii.variant_id,
                COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0) AS inv_usa,
                COALESCE(SUM(CASE WHEN il.location_id = $3 THEN GREATEST(0, il.stocked_quantity - il.reserved_quantity) ELSE 0 END), 0) AS inv_china
         FROM product_variant_inventory_item pvii
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = ii.id
           AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
         WHERE pvii.variant_id = ANY($1::text[])
         GROUP BY pvii.variant_id`,
          [allIds, USA_LOC, CHINA_LOC]
        ),
        db.query<{ variant_id: string; production_days: string }>(
          `SELECT pv.id AS variant_id,
                COALESCE((qv.metadata->>'production_days')::int, 10) AS production_days
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
         JOIN qb_vendor qv ON qv.qb_list_id = (p.metadata->>'qb_vendor_list_id')
           AND qv.deleted_at IS NULL
         WHERE pv.deleted_at IS NULL
           AND p.metadata->>'qb_vendor_list_id' IS NOT NULL
           AND pv.id = ANY($1::text[])`,
          [allIds]
        ),
        db.query<{ variant_id: string; abc_class: string | null }>(
          `SELECT variant_id, abc_class FROM purchasing_snapshot WHERE variant_id = ANY($1::text[])`,
          [variantIds]
        ),
        db.query<{
          sku: string;
          on_order_usa: string;
          on_order_china: string;
        }>(
          `SELECT sku, SUM(on_order_usa) AS on_order_usa, SUM(on_order_china) AS on_order_china
           FROM (
             SELECT pol.sku_snapshot AS sku,
                    CASE WHEN BTRIM(po.stock_location_id, E' \\t\\n\\r') = $2
                         THEN GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)
                         ELSE 0 END AS on_order_usa,
                    CASE WHEN BTRIM(po.stock_location_id, E' \\t\\n\\r') = $3
                         THEN GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled)
                         ELSE 0 END AS on_order_china
             FROM purchase_order_line pol
             JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
             WHERE po.status IN ('submitted', 'partially_received')
               AND pol.status IN ('open', 'partial')
               AND pol.deleted_at IS NULL
               AND pol.sku_snapshot = ANY($1::text[])
             UNION ALL
             SELECT fol.sku_snapshot AS sku,
                    0 AS on_order_usa,
                    CASE WHEN BTRIM(fo.stock_location_id, E' \\t\\n\\r') = $3
                         THEN GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled)
                         ELSE 0 END AS on_order_china
             FROM factory_order_line fol
             JOIN factory_order fo ON fo.id = fol.factory_order_id AND fo.deleted_at IS NULL
             WHERE fo.status IN ('submitted', 'partially_received')
               AND fol.status IN ('open', 'partial')
               AND fol.deleted_at IS NULL
               AND fol.sku_snapshot = ANY($1::text[])
           ) combined
           GROUP BY sku`,
          [skusForPo, USA_LOC, CHINA_LOC]
        ),
        db.query<{ variant_id: string }>(
          `SELECT pv.id AS variant_id
           FROM product_variant pv
           JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
           WHERE pv.deleted_at IS NULL
             AND pv.id = ANY($1::text[])
             AND COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) = true`,
          [allIds]
        ),
      ]);
    const sourcedFromChinaPartial = new Set(
      sourcedPartialRes.rows.map((r) => r.variant_id)
    );

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
    const poUsaBySku = new Map(
      poPartialRes.rows.map((r) => [r.sku, Number(r.on_order_usa)])
    );
    const poChinaBySku = new Map(
      poPartialRes.rows.map((r) => [r.sku, Number(r.on_order_china)])
    );

    const leadAirPartial = cfg.transit_air_days + cfg.buffer_air_days;

    for (const variantId of variantIds) {
      try {
        const alts = altsByPrimary.get(variantId) ?? [];
        const sales = calculateDailySales(variantId, alts, cfg, engineCtx);
        const inv = invByVariant.get(variantId) ?? { usa: 0, china: 0 };
        const isSourcedChina = sourcedFromChinaPartial.has(variantId);
        let altInvUsa = 0;
        let altInvChina = 0;
        let altPoChina = 0;
        for (const altId of alts) {
          altInvUsa += invByVariant.get(altId)?.usa ?? 0;
          if (isSourcedChina) {
            altInvChina += invByVariant.get(altId)?.china ?? 0;
            const altSku = skuByVariant.get(altId);
            if (altSku) altPoChina += poChinaBySku.get(altSku) ?? 0;
          }
        }

        const abcClass = abcClassPartial.get(variantId) ?? "C";
        const factoryMult = factoryMultFor(cfg, abcClass);
        const prodDays = prodDaysPartial.get(variantId) ?? 10;
        const effectiveDays = Math.round(prodDays * factoryMult);

        const sku = skuByVariant.get(variantId) ?? "";
        const onPoUsa = poUsaBySku.get(sku) ?? 0;
        const onPoChina = isSourcedChina ? (poChinaBySku.get(sku) ?? 0) : 0;
        const invChinaOwn = isSourcedChina ? inv.china : 0;
        const qty_to_transfer = Math.max(
          0,
          Math.round(
            sales.daily_sales_est * leadAirPartial -
              inv.usa -
              altInvUsa -
              onPoUsa
          )
        );
        const supplyChina = isSourcedChina
          ? invChinaOwn + altInvChina + onPoChina + altPoChina
          : 0;
        const qty_to_factory = isSourcedChina
          ? Math.max(
              0,
              Math.round(sales.daily_sales_est * effectiveDays - supplyChina)
            )
          : 0;

        // Pareto rank/class are NOT updated here — they depend on global ranking
        // and must be recomputed by a full runPurchasingSnapshot pass.
        await db.query(
          `UPDATE purchasing_snapshot
           SET tier0_30d=$2, sales_q1=$3, sales_q2=$4, sales_q3=$5, sales_q4=$6,
               daily_sales_est=$7, monthly_sales_est=$8, cv=$9,
               inv_usa=$10, inv_china=$11, inv_china_alt=$12,
               qty_on_po_china=$13, qty_on_po_china_alt=$14,
               qty_to_transfer=$15, qty_to_factory=$16, production_days=$17,
               unmet_net_30d=$18, weighted_revenue=$19,
               first_sale_date=$20,
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
            invChinaOwn,
            altInvChina,
            onPoChina,
            altPoChina,
            qty_to_transfer,
            qty_to_factory,
            prodDays,
            sales.unmet_net_30d ?? 0,
            sales.weighted_revenue,
            sales.first_sale_date,
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
