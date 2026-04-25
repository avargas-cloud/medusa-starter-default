/**
 * GET /admin/purchasing/analysis-settings  — load toolbar settings
 * PUT /admin/purchasing/analysis-settings  — save toolbar settings
 *
 * Stored in store.metadata.purchasing_analysis_settings as a JSON blob.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

export interface PurchasingAnalysisSettings {
  tendency: number;
  inv_days_a: number;
  inv_days_other: number;
  china_to_usa_days: number;
}

const DEFAULTS: PurchasingAnalysisSettings = {
  tendency: 5,
  inv_days_a: 30,
  inv_days_other: 15,
  china_to_usa_days: 27,
};

async function loadSettings(): Promise<PurchasingAnalysisSettings> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const { rows } = await db.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM store LIMIT 1`
    );
    const stored = rows[0]?.metadata?.purchasing_analysis_settings as Partial<PurchasingAnalysisSettings> | undefined;
    return { ...DEFAULTS, ...stored };
  } catch {
    return DEFAULTS;
  } finally {
    await db.end();
  }
}

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  return res.json(await loadSettings());
}

export async function PUT(
  req: AuthenticatedMedusaRequest<Partial<PurchasingAnalysisSettings>>,
  res: MedusaResponse
) {
  const body = req.body ?? {};
  const current = await loadSettings();
  const updated: PurchasingAnalysisSettings = {
    tendency:         typeof body.tendency         === "number" ? body.tendency         : current.tendency,
    inv_days_a:       typeof body.inv_days_a       === "number" ? body.inv_days_a       : current.inv_days_a,
    inv_days_other:   typeof body.inv_days_other   === "number" ? body.inv_days_other   : current.inv_days_other,
    china_to_usa_days: typeof body.china_to_usa_days === "number" ? body.china_to_usa_days : current.china_to_usa_days,
  };

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    await db.query(
      `UPDATE store SET metadata = COALESCE(metadata, '{}') || $1::jsonb`,
      [JSON.stringify({ purchasing_analysis_settings: updated })]
    );
    return res.json(updated);
  } catch (err: unknown) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    await db.end();
  }
}
