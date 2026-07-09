/**
 * GET /admin/settings/payment-batch-cutoff → { cutoff: "18:45" }
 * PUT /admin/settings/payment-batch-cutoff → update the merchant batch cutoff
 *
 * Storage: store.metadata.payment_batch_cutoff ("HH:MM", ET) in the Medusa
 * store table — same pattern as admin_override_pass. Payments taken after
 * this wall-clock time (ET) get batch_day = next day. Consumed by
 * lib/finance/batch-day.ts (60s in-memory cache; the PUT invalidates the
 * local process immediately, other instances converge within the TTL).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  DEFAULT_BATCH_CUTOFF,
  invalidateBatchCutoffCache,
  parseCutoff,
} from "../../../../lib/finance/batch-day";

const DEFAULT_CUTOFF_STRING = `${String(DEFAULT_BATCH_CUTOFF.h).padStart(2, "0")}:${String(DEFAULT_BATCH_CUTOFF.m).padStart(2, "0")}`;

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ cutoff: string | null }>(
      `SELECT metadata->>'payment_batch_cutoff' AS cutoff FROM store LIMIT 1`
    );
    const parsed = parseCutoff(rows[0]?.cutoff);
    const cutoff = parsed
      ? `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`
      : DEFAULT_CUTOFF_STRING;
    return res.json({ cutoff });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function PUT(
  req: AuthenticatedMedusaRequest<{ cutoff?: string }>,
  res: MedusaResponse
) {
  const { cutoff } = req.body;
  const parsed = parseCutoff(cutoff);
  if (!parsed) {
    return res
      .status(400)
      .json({ error: "cutoff must be HH:MM (00:00–23:59)" });
  }
  const normalized = `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`;

  try {
    const pool = getDbPool();
    await pool.query(
      `UPDATE store
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('payment_batch_cutoff', $1::text)`,
      [normalized]
    );
    invalidateBatchCutoffCache();
    return res.json({ cutoff: normalized });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
