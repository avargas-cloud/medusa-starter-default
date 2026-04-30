import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { bridgeFetch } from "../../../../../lib/quickbooks/client/core";

/**
 * DELETE /admin/quickbooks/pipeline
 *
 * Flushes stale operations from both sources:
 *   1. Bridge in-memory queue (all pending/processing ops → failed)
 *   2. Medusa qb_order_pipeline table (all rows deleted)
 *
 * Query params:
 *   bridge=true   — flush the bridge queue (default: true)
 *   medusa=true   — clear the Medusa pipeline table (default: true)
 *   reason        — optional label for the audit log
 */
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const flushBridge = req.query.bridge !== "false";
  const flushMedusa = req.query.medusa !== "false";
  const reason =
    (req.query.reason as string | undefined) ||
    "Admin pipeline flush via Medusa UI";

  const result: Record<string, unknown> = {};

  // 1. Flush bridge queue
  if (flushBridge) {
    try {
      const bridgeRes = await bridgeFetch("POST", "/api/sync/queue/flush", {
        reason,
      });
      result.bridge = {
        flushed: bridgeRes.count ?? 0,
        message: bridgeRes.message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.bridge = { error: msg };
    }
  }

  // 2. Clear Medusa pipeline table
  if (flushMedusa) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const { rowCount } = await client.query("DELETE FROM qb_order_pipeline");
      result.medusa = { deleted: rowCount };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.medusa = { error: msg };
    } finally {
      await client.end();
    }
  }

  res.json({ success: true, ...result });
}
