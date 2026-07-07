/**
 * GET  /admin/purchasing/config — return all config key/value pairs
 * PUT  /admin/purchasing/config — update one or more keys
 *      Body: { key: string, value: string | number }[]
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

async function getDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return db;
}

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const db = await getDb();
  try {
    const rows = await db.query<{
      key: string;
      value: string;
      description: string | null;
    }>(
      // Column is `label` (there is no `description` column) — alias it so the
      // response shape stays stable.
      `SELECT key, value, label AS description FROM purchasing_config ORDER BY key`
    );
    return res.json({ config: rows.rows });
  } finally {
    await db.end();
  }
}

export async function PUT(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const updates = req.body as Array<{ key: string; value: string | number }>;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({
      error: "Body must be a non-empty array of { key, value } pairs",
    });
  }

  const db = await getDb();
  try {
    for (const { key, value } of updates) {
      // Upsert (not bare UPDATE): a missing key row would otherwise make the
      // save a silent no-op — e.g. a newly-added config key whose seed migration
      // hasn't run yet on this instance. NOTE: purchasing_config has no
      // updated_at column (only key/value/label), so don't reference it.
      await db.query(
        `INSERT INTO purchasing_config (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    }
    const rows = await db.query<{
      key: string;
      value: string;
      description: string | null;
    }>(
      // Column is `label` (there is no `description` column) — alias it so the
      // response shape stays stable.
      `SELECT key, value, label AS description FROM purchasing_config ORDER BY key`
    );
    return res.json({ ok: true, config: rows.rows });
  } finally {
    await db.end();
  }
}
