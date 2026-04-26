/**
 * ParetoEngine — ABC-XYZ classification
 *
 * ABC (by weighted 12-month revenue):
 *   A: cumulative ≤ pareto_a_threshold  (80%)
 *   B: cumulative ≤ pareto_b_threshold  (95%)
 *   C: rest
 *
 * XYZ (by coefficient of variation of monthly demand):
 *   X: CV < xyz_x_threshold  (0.50) — stable demand
 *   Y: CV < xyz_y_threshold  (1.00) — variable demand
 *   Z: CV ≥ xyz_y_threshold         — erratic demand
 */

import { PurchasingConfig } from "./purchasing-config.service";

export interface VariantForPareto {
  variant_id: string;
  revenue_12m: number;
  cv: number;
}

export interface ParetoResult {
  variant_id: string;
  abc_class: "A" | "B" | "C";
  xyz_class: "X" | "Y" | "Z";
  abcxyz_class: string;
}

export function runParetoEngine(
  variants: VariantForPareto[],
  cfg: PurchasingConfig
): ParetoResult[] {
  const totalRevenue = variants.reduce((s, v) => s + v.revenue_12m, 0);

  // ABC: sort by revenue descending, assign cumulative %
  const sorted = [...variants].sort((a, b) => b.revenue_12m - a.revenue_12m);
  let cumulative = 0;
  const abcMap = new Map<string, "A" | "B" | "C">();

  for (const v of sorted) {
    if (totalRevenue > 0) {
      cumulative += v.revenue_12m / totalRevenue;
    }
    if (cumulative <= cfg.pareto_a_threshold) {
      abcMap.set(v.variant_id, "A");
    } else if (cumulative <= cfg.pareto_b_threshold) {
      abcMap.set(v.variant_id, "B");
    } else {
      abcMap.set(v.variant_id, "C");
    }
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
    };
  });
}
