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
    }>(`SELECT key, value, description FROM purchasing_config ORDER BY key`);
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
      await db.query(
        `UPDATE purchasing_config SET value = $2, updated_at = now() WHERE key = $1`,
        [key, String(value)]
      );
    }
    const rows = await db.query<{
      key: string;
      value: string;
      description: string | null;
    }>(`SELECT key, value, description FROM purchasing_config ORDER BY key`);
    return res.json({ ok: true, config: rows.rows });
  } finally {
    await db.end();
  }
}
