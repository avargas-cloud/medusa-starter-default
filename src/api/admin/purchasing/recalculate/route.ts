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

import { runPurchasingSnapshot } from "../../../../services/purchasing/snapshot.service";

export async function POST(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const result = await runPurchasingSnapshot();
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
