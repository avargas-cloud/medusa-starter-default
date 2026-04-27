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
 *   X: CV < xyz_x_threshold  (0.50) — stable demand
 *   Y: CV < xyz_y_threshold  (1.00) — variable demand
 *   Z: CV ≥ xyz_y_threshold         — erratic demand
 */

import { PurchasingConfig } from "./purchasing-config.service";

export interface VariantForPareto {
  variant_id: string;
  /** Ranking metric (tier-weighted monthly revenue, NET of returns). */
  revenue: number;
  cv: number;
}

export interface ParetoResult {
  variant_id: string;
  abc_class: "A" | "B" | "C";
  xyz_class: "X" | "Y" | "Z";
  abcxyz_class: string;
  /** 1-indexed rank in the sorted-desc revenue list. Null if revenue ≤ 0. */
  pareto_rank: number | null;
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
    const xyz: "X" | "Y" | "Z" =
      v.cv < cfg.xyz_x_threshold ? "X" : v.cv < cfg.xyz_y_threshold ? "Y" : "Z";
    return {
      variant_id: v.variant_id,
      abc_class: abc,
      xyz_class: xyz,
      abcxyz_class: `${abc}${xyz}`,
      pareto_rank: rankMap.get(v.variant_id) ?? null,
    };
  });
}
