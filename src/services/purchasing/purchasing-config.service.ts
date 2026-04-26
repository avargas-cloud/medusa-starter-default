import { Client } from "pg";

export interface PurchasingConfig {
  weight_tier0_30d: number;
  weight_q4: number;
  weight_q3: number;
  weight_q2: number;
  weight_q1: number;
  tendency_adj: number;
  business_days_per_month: number;
  pareto_a_threshold: number;
  pareto_b_threshold: number;
  xyz_x_threshold: number;
  xyz_y_threshold: number;
  transit_air_days: number;
  buffer_air_days: number;
  transit_sea_days: number;
  buffer_sea_days: number;
}

const DEFAULTS: PurchasingConfig = {
  weight_tier0_30d: 0.3,
  weight_q4: 0.25,
  weight_q3: 0.2,
  weight_q2: 0.15,
  weight_q1: 0.1,
  tendency_adj: 0.05,
  business_days_per_month: 26,
  pareto_a_threshold: 0.8,
  pareto_b_threshold: 0.95,
  xyz_x_threshold: 0.5,
  xyz_y_threshold: 1.0,
  transit_air_days: 12,
  buffer_air_days: 15,
  transit_sea_days: 90,
  buffer_sea_days: 45,
};

export async function loadPurchasingConfig(
  db: Client
): Promise<PurchasingConfig> {
  const res = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM purchasing_config`
  );
  const config = { ...DEFAULTS };
  for (const row of res.rows) {
    const k = row.key as keyof PurchasingConfig;
    if (k in config) {
      (config as Record<string, number>)[k] = parseFloat(row.value);
    }
  }
  return config;
}
