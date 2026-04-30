import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const step = req.query.step as string | undefined;
    const refId = req.query.reference_id as string | undefined;
    const search = req.query.search as string | undefined;
    const sortBy =
      req.query.sort_by === "updated_at" ? "updated_at" : "created_at";

    // Auto-timeout: submitted rows older than 10 min with no bridge_op_id → failed
    const { rows: timeout1 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'Submission timed out — no bridge_op_id recorded'
            WHERE status = 'submitted'
              AND bridge_op_id IS NULL
              AND submitted_at < NOW() - INTERVAL '10 minutes'
            RETURNING step, qb_txn_id
        `);

    // Auto-timeout: submitted rows with bridge_op_id older than 15 min (QBWC not responding) → failed
    const { rows: timeout2 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'QBWC did not respond within 15 minutes — QuickBooks Desktop may be offline or QBWC disconnected'
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
              AND submitted_at < NOW() - INTERVAL '15 minutes'
            RETURNING step, qb_txn_id
        `);

    // Auto-timeout: pending rows older than 30 min (handler never re-submitted) → failed
    // Uses updated_at so reactivated rows (confirmed→pending) don't immediately time out
    const { rows: timeout3 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'Operation stuck in pending — handler did not re-submit within 30 minutes'
            WHERE status = 'pending'
              AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '30 minutes'
            RETURNING step, qb_txn_id
        `);

    // Invalidate cached EditSequence for all timed-out rows
    const {
      invalidateEditSequenceCache,
    } = require("../../../../../lib/quickbooks/qb-pipeline");
    for (const r of [...timeout1, ...timeout2, ...timeout3]) {
      if (r.qb_txn_id) {
        await invalidateEditSequenceCache(r.step, r.qb_txn_id).catch(() => {});
      }
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let p = 1;

    if (status) {
      conditions.push(`p.status = $${p++}`);
      values.push(status);
    }
    if (step) {
      conditions.push(`p.step = $${p++}`);
      values.push(step);
    } else {
      // El Sales Pipeline (sin filtro step explícito) no debe mostrar
      // rows de customer_data_ext — tienen su propio tab "Customer Sync".
      conditions.push(`p.step <> 'customer_data_ext'`);
    }
    if (refId) {
      conditions.push(`(p.order_id = $${p} OR p.reference_id = $${p})`);
      values.push(refId);
      p++;
    }
    if (search) {
      conditions.push(`(
        p.medusa_ref_number ILIKE $${p}
        OR p.qb_ref_number ILIKE $${p}
        OR CAST(p.seq AS TEXT) ILIKE $${p}
        OR p.order_id IN (
          SELECT id FROM "order" WHERE CAST(display_id AS TEXT) ILIKE $${p}
        )
      )`);
      values.push(`%${search}%`);
      p++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await client.query(
      `
            SELECT
                p.seq,
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
                p.medusa_ref_number,
                p.error,
                p.created_at,
                p.updated_at,
                p.submitted_at,
                p.confirmed_at,
                p.failed_at,
                -- Order display_id: direct for order rows, via pos_credit_memo for credit_memo rows
                COALESCE(ord.display_id, cm_ord.display_id) AS order_display_id,
                -- Include parent step info for context
                dep.step AS depends_on_step,
                dep.status AS depends_on_status,
                dep.medusa_ref_number AS depends_on_medusa_ref,
                -- For apply_payment: also join the payment row for dual-dependency display
                pay_dep.medusa_ref_number AS payment_dep_ref,
                pay_dep.status AS payment_dep_status
            FROM qb_order_pipeline p
            LEFT JOIN "order" ord ON ord.id = p.order_id
            LEFT JOIN pos_credit_memo cm ON p.reference_type = 'credit_memo' AND cm.id = p.reference_id
            LEFT JOIN "order" cm_ord ON cm_ord.id = cm.order_id
            LEFT JOIN qb_order_pipeline dep ON dep.id = p.depends_on
            LEFT JOIN qb_order_pipeline pay_dep
                ON p.step = 'apply_payment'
                AND pay_dep.reference_id = p.reference_id
                AND pay_dep.step = 'payment'
            ${where}
            ORDER BY ${sortBy === "updated_at" ? "COALESCE(p.updated_at, p.created_at)" : "p.created_at"} DESC
            LIMIT $${p} OFFSET $${p + 1}
        `,
      [...values, limit, offset]
    );

    const countResult = await client.query(
      `SELECT COUNT(*) FROM qb_order_pipeline p ${where}`,
      values
    );
    const total = parseInt(countResult.rows[0].count);

    // Summary counts per status (for header badges).
    // Uses the same step scope as the main rows query so the badge always
    // matches what the user sees — but excludes the status filter so we get
    // a count for every status bucket, not just the active one.
    const summaryStepCondition = step
      ? `step = $1`
      : `step <> 'customer_data_ext'`;
    const summaryValues = step ? [step] : [];
    const { rows: summary } = await client.query(
      `SELECT status, COUNT(*) AS count
       FROM qb_order_pipeline
       WHERE ${summaryStepCondition}
       GROUP BY status`,
      summaryValues
    );
    const counts: Record<string, number> = {};
    for (const row of summary) {
      counts[row.status] = parseInt(row.count);
    }

    res.json({
      pipeline: rows,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
      counts,
    });
  } catch (err: unknown) {
    console.error("[QB Pipeline GET] Error:", err);
    res.status(500).json({ error: "Failed to fetch pipeline" });
  } finally {
    await client.end();
  }
}
