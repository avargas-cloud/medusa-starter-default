/**
 * POST /admin/purchasing/recalculate
 *
 * Triggers an immediate purchasing snapshot recalculation.
 * Runs synchronously (may take 10-60s for large catalogs).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";

import { runPurchasingSnapshot } from "../../../../services/purchasing/snapshot.service";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const force =
      (req.query as Record<string, string>)?.force === "true" ||
      (req.query as Record<string, string>)?.force === "1";
    const result = await runPurchasingSnapshot({ force });

    // Always bump last_calculated_at so the UI reflects the button click time,
    // even when the smart-skip logic processed 0 rows.
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query(`UPDATE purchasing_snapshot SET last_calculated_at = NOW()`);
    } finally {
      await db.end();
    }

    return res.json({
      ok: true,
      processed: result.processed,
      errors: result.errors,
      duration_ms: result.durationMs,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
