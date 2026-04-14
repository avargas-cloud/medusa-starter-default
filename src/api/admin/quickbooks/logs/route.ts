import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

/**
 * GET /admin/quickbooks/logs
 * Returns QB process logs from qb_sync_log with filtering and pagination.
 *
 * Query params:
 *   limit    — rows per page (default 25)
 *   offset   — for pagination (default 0)
 *   category — 'order' | 'sync' | all (default: all)
 *   status   — 'processing' | 'completed' | 'failed' | 'skipped' (optional)
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string | undefined; // 'order' | 'sync'
    const status = req.query.status as string | undefined;

    await client.connect();

    // ── Auto-cleanup: mark stale "processing" entries as failed ──────────
    // If a sync job crashed/errored after writing the log, it stays stuck at
    // "processing" forever. Clean up any that are >5 minutes old.
    await client.query(`
            UPDATE qb_sync_log
            SET
                status       = 'failed',
                completed_at = NOW(),
                duration_ms  = EXTRACT(EPOCH FROM (NOW() - initiated_at)) * 1000,
                error        = 'Job timed out — process may have crashed or restarted'
            WHERE status = 'processing'
              AND initiated_at < NOW() - INTERVAL '5 minutes'
        `);

    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    // Activity Log only shows background sync operations.
    // Order/payment events are tracked in the QB Operations Pipeline instead.
    // The 'sync' category param is kept for backwards compat but is now the default.
    if (category !== "all") {
      conditions.push(
        `operation IN ('inventory_sync','price_sync','customer_sync','pos_sync')`
      );
    }

    if (status) {
      conditions.push(`status = $${p++}`);
      values.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await client.query(
      `
            SELECT
                id,
                operation,
                status,
                order_id,
                order_display_id,
                draft_order_id,
                event_type,
                sync_type,
                triggered_by,
                message,
                error,
                qb_txn_id,
                qb_ref_number,
                duration_ms,
                initiated_at,
                completed_at,
                metadata,
                server_host
            FROM qb_sync_log
            ${where}
            ORDER BY initiated_at DESC
            LIMIT $${p} OFFSET $${p + 1}
        `,
      [...values, limit, offset]
    );

    const countResult = await client.query(
      `SELECT COUNT(*) FROM qb_sync_log ${where}`,
      values
    );
    const total = parseInt(countResult.rows[0].count);

    res.json({
      logs: rows.rows,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + rows.rows.length < total,
      },
    });
  } catch (error: any) {
    console.error("Error fetching QB logs:", error);
    res.status(500).json({ error: "Failed to fetch logs" });
  } finally {
    await client.end();
  }
}

/**
 * DELETE /admin/quickbooks/logs
 * Clears all rows from qb_sync_log.
 */
export async function DELETE(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rowCount } = await client.query("DELETE FROM qb_sync_log");
    res.json({ success: true, deleted: rowCount });
  } catch (err: any) {
    console.error("[QB Logs DELETE] Error:", err);
    res.status(500).json({ error: "Failed to clear logs" });
  } finally {
    await client.end();
  }
}
