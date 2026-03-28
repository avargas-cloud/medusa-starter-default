import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch } from "../../../../lib/quickbooks/client/core"

/**
 * GET /admin/quickbooks/pipeline
 *
 * Returns rows from qb_order_pipeline — the real-time QB operations queue.
 *
 * Query params:
 *   limit        — rows per page (default 30, max 100)
 *   offset       — pagination (default 0)
 *   status       — 'pending' | 'submitted' | 'confirmed' | 'failed' | 'skipped'
 *   step         — 'estimate' | 'sales_order' | 'invoice' | 'payment' | 'apply_payment'
 *                  | 'sales_receipt' | 'credit_memo' | 'write_check'
 *   reference_id — filter by order_id or reference_id
 *
 * POST /admin/quickbooks/pipeline/:id/retry
 *   Resets a failed row back to 'pending' so the cron picks it up again.
 */

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        const limit  = Math.min(parseInt(req.query.limit  as string) || 30, 100)
        const offset = parseInt(req.query.offset as string) || 0
        const status = req.query.status       as string | undefined
        const step   = req.query.step         as string | undefined
        const refId  = req.query.reference_id as string | undefined

        // Auto-timeout: submitted rows older than 10 min with no bridge_op_id → failed
        await client.query(`
            UPDATE qb_order_pipeline
            SET status    = 'failed',
                failed_at = NOW(),
                error     = 'Submission timed out — no bridge_op_id recorded'
            WHERE status = 'submitted'
              AND bridge_op_id IS NULL
              AND submitted_at < NOW() - INTERVAL '10 minutes'
        `)

        const conditions: string[] = []
        const values: any[] = []
        let p = 1

        if (status) { conditions.push(`p.status = $${p++}`); values.push(status) }
        if (step)   { conditions.push(`p.step = $${p++}`);   values.push(step) }
        if (refId)  {
            conditions.push(`(p.order_id = $${p} OR p.reference_id = $${p})`)
            values.push(refId); p++
        }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

        const { rows } = await client.query(`
            SELECT
                p.id,
                p.order_id,
                p.reference_id,
                p.reference_type,
                p.step,
                p.status,
                p.depends_on,
                p.bridge_op_id,
                p.retry_count,
                p.qb_txn_id,
                p.qb_ref_number,
                p.error,
                p.created_at,
                p.submitted_at,
                p.confirmed_at,
                p.failed_at,
                -- Include parent step name for context
                dep.step AS depends_on_step,
                dep.status AS depends_on_status
            FROM qb_order_pipeline p
            LEFT JOIN qb_order_pipeline dep ON dep.id = p.depends_on
            ${where}
            ORDER BY p.created_at DESC
            LIMIT $${p} OFFSET $${p + 1}
        `, [...values, limit, offset])

        const countResult = await client.query(
            `SELECT COUNT(*) FROM qb_order_pipeline p ${where}`,
            values
        )
        const total = parseInt(countResult.rows[0].count)

        // Summary counts per status (for header badges)
        const { rows: summary } = await client.query(`
            SELECT status, COUNT(*) AS count
            FROM qb_order_pipeline
            GROUP BY status
        `)
        const counts: Record<string, number> = {}
        for (const row of summary) {
            counts[row.status] = parseInt(row.count)
        }

        res.json({
            pipeline: rows,
            pagination: { total, limit, offset, hasMore: offset + rows.length < total },
            counts,
        })

    } catch (err: any) {
        console.error("[QB Pipeline GET] Error:", err)
        res.status(500).json({ error: "Failed to fetch pipeline" })
    } finally {
        await client.end()
    }
}

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    // POST /admin/quickbooks/pipeline?action=retry&id=<uuid>
    // Resets a failed row to pending so the cron retries it
    const rowId  = req.query.id     as string | undefined
    const action = req.query.action as string | undefined

    if (!rowId || action !== "retry") {
        res.status(400).json({ error: "Requires ?action=retry&id=<uuid>" })
        return
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()
        const { rowCount } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'pending',
                error        = NULL,
                failed_at    = NULL,
                bridge_op_id = NULL,
                retry_count  = retry_count + 1
            WHERE id = $1 AND status = 'failed'
        `, [rowId])

        if (!rowCount) {
            res.status(404).json({ error: "Row not found or not in failed status" })
            return
        }
        res.json({ success: true, message: "Row reset to pending — cron will retry it" })
    } catch (err: any) {
        console.error("[QB Pipeline POST] Error:", err)
        res.status(500).json({ error: "Failed to retry" })
    } finally {
        await client.end()
    }
}

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
    const flushBridge = req.query.bridge !== "false"
    const flushMedusa = req.query.medusa !== "false"
    const reason = (req.query.reason as string | undefined)
        || "Admin pipeline flush via Medusa UI"

    const result: Record<string, any> = {}

    // 1. Flush bridge queue
    if (flushBridge) {
        try {
            const bridgeRes = await bridgeFetch("POST", "/api/sync/queue/flush", { reason })
            result.bridge = { flushed: bridgeRes.count ?? 0, message: bridgeRes.message }
        } catch (err: any) {
            result.bridge = { error: err.message }
        }
    }

    // 2. Clear Medusa pipeline table
    if (flushMedusa) {
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        try {
            await client.connect()
            const { rowCount } = await client.query("DELETE FROM qb_order_pipeline")
            result.medusa = { deleted: rowCount }
        } catch (err: any) {
            result.medusa = { error: err.message }
        } finally {
            await client.end()
        }
    }

    res.json({ success: true, ...result })
}
