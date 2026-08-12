/**
 * ParetoEngine — ABC-XYZ classification
 *
 * ABC (by tier-weighted monthly revenue, NET of returns):
 *   A: cumulative ≤ pareto_a_threshold  (80%)
 *   B: cumulative ≤ pareto_b_threshold  (95%)
 *   C: rest
 *
 * Recency weights: tier0 30%, Q4 25%, Q3 20%, Q2 15%, Q1 10%.
 *
 * XYZ (by coefficient of variation of monthly demand):
 *   N: fewer than MIN_CV_POINTS months in the CV series — new/insufficient
 *      history. With 0-1 data points variance is 0 by construction, so a
 *      brand-new SKU would otherwise claim X ("stable") with zero evidence.
 *   X: CV < xyz_x_threshold  (0.50) — stable demand
 *   Y: CV < xyz_y_threshold  (1.00) — variable demand
 *   Z: CV ≥ xyz_y_threshold         — erratic demand
 */

import { PurchasingConfig } from "./purchasing-config.service";

/**
 * Minimum months in the CV series to graduate from N to X/Y/Z. At 3 points the
 * CV starts discriminating (sampling error ~50%); below that it is noise.
 * Frontend treats 3-5 points as "provisional" (tooltip flag, driven by
 * cv_points — no backend logic involved).
 */
export const MIN_CV_POINTS = 3;

export type XyzClass = "X" | "Y" | "Z" | "N";

export interface VariantForPareto {
  variant_id: string;
  /** Ranking metric (tier-weighted monthly revenue, NET of returns). */
  revenue: number;
  cv: number;
  /** Months actually in the CV series (excludes current + tier0-fallback month). */
  cv_points: number;
}

export interface ParetoResult {
  variant_id: string;
  abc_class: "A" | "B" | "C";
  xyz_class: XyzClass;
  abcxyz_class: string;
  /** 1-indexed rank in the sorted-desc revenue list. Null if revenue ≤ 0. */
  pareto_rank: number | null;
}

/** Single source of truth for the XYZ letter — used by the engine and by the
 * alt-variant path in snapshot.service. */
export function xyzClassFor(
  cv: number,
  cvPoints: number,
  cfg: PurchasingConfig
): XyzClass {
  if (cvPoints < MIN_CV_POINTS) return "N";
  return cv < cfg.xyz_x_threshold ? "X" : cv < cfg.xyz_y_threshold ? "Y" : "Z";
}

export function runParetoEngine(
  variants: VariantForPareto[],
  cfg: PurchasingConfig
): ParetoResult[] {
  const totalRevenue = variants.reduce((s, v) => s + v.revenue, 0);

  // ABC + rank: sort by revenue descending, assign cumulative %
  const sorted = [...variants].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;
  const abcMap = new Map<string, "A" | "B" | "C">();
  const rankMap = new Map<string, number | null>();
  let nextRank = 1;

  for (const v of sorted) {
    if (totalRevenue > 0) {
      cumulative += v.revenue / totalRevenue;
    }
    if (cumulative <= cfg.pareto_a_threshold) {
      abcMap.set(v.variant_id, "A");
    } else if (cumulative <= cfg.pareto_b_threshold) {
      abcMap.set(v.variant_id, "B");
    } else {
      abcMap.set(v.variant_id, "C");
    }
    rankMap.set(v.variant_id, v.revenue > 0 ? nextRank++ : null);
  }

  return variants.map((v) => {
    const abc = abcMap.get(v.variant_id) ?? "C";
    const xyz = xyzClassFor(v.cv, v.cv_points, cfg);
    return {
      variant_id: v.variant_id,
      abc_class: abc,
      xyz_class: xyz,
      abcxyz_class: `${abc}${xyz}`,
      pareto_rank: rankMap.get(v.variant_id) ?? null,
    };
  });
}
