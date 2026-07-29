import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import {
  PURCHASE_PIPELINE_STEPS,
  SALES_PIPELINE_EXCLUDED_STEPS,
  salesPipelineStepScopeSql,
} from "../../../../../lib/quickbooks/pipeline/sales-pipeline-scope";

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

    // Auto-timeout: submitted rows older than 10 min with no bridge_op_id → failed + schedule retry if budget remains
    const { rows: timeout1 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status        = 'failed',
                failed_at     = NOW(),
                confirmed_at  = NULL,
                updated_at    = NOW(),
                error         = 'Submission timed out — no bridge_op_id recorded',
                next_retry_at = CASE WHEN COALESCE(retry_count, 0) < 5 THEN NOW() + INTERVAL '2 minutes' ELSE NULL END
            WHERE status = 'submitted'
              AND bridge_op_id IS NULL
              AND step <> ALL($1::text[])
              AND submitted_at < NOW() - INTERVAL '10 minutes'
            RETURNING step, qb_txn_id
        `, [PURCHASE_PIPELINE_STEPS]);

    // Auto-timeout: submitted rows with bridge_op_id older than 15 min (QBWC not responding) → failed + schedule retry
    const { rows: timeout2 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status        = 'failed',
                failed_at     = NOW(),
                confirmed_at  = NULL,
                updated_at    = NOW(),
                error         = 'QBWC did not respond within 15 minutes — QuickBooks Desktop may be offline or QBWC disconnected',
                next_retry_at = CASE WHEN COALESCE(retry_count, 0) < 5 THEN NOW() + INTERVAL '2 minutes' ELSE NULL END
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
              AND step <> ALL($1::text[])
              AND submitted_at < NOW() - INTERVAL '15 minutes'
            RETURNING step, qb_txn_id
        `, [PURCHASE_PIPELINE_STEPS]);

    // Auto-timeout: pending rows older than 30 min (handler never re-submitted) → failed + schedule retry
    // Uses updated_at so reactivated rows (confirmed→pending) don't immediately time out
    const { rows: timeout3 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status        = 'failed',
                failed_at     = NOW(),
                confirmed_at  = NULL,
                updated_at    = NOW(),
                error         = 'Operation stuck in pending — handler did not re-submit within 30 minutes',
                next_retry_at = CASE WHEN COALESCE(retry_count, 0) < 5 THEN NOW() + INTERVAL '2 minutes' ELSE NULL END
            WHERE status = 'pending'
              AND step <> ALL($1::text[])
              AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '30 minutes'
            RETURNING step, qb_txn_id
        `, [PURCHASE_PIPELINE_STEPS]);

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
      // Exclude steps that have dedicated tabs in the QB pipeline UI.
      // Scope shared with the badge summary below — see sales-pipeline-scope.ts.
      conditions.push(salesPipelineStepScopeSql(p++, "p"));
      values.push(SALES_PIPELINE_EXCLUDED_STEPS);
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
                p.tab_seq,
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
                -- Include parent step info for context (used for non-apply_payment rows)
                dep.step AS depends_on_step,
                dep.status AS depends_on_status,
                dep.medusa_ref_number AS depends_on_medusa_ref,
                -- ── apply_payment dual-dependency display ────────────────────
                -- Always show two facts for an apply_payment row, derived from
                -- the documents (not from depends_on, which only tracks the
                -- current sync gate):
                --   SOURCE: where the money came from — Payment or Credit Memo.
                --   TARGET: which document it was applied to — usually Invoice.
                source_dep.step AS source_dep_step,
                source_dep.status AS source_dep_status,
                source_dep.medusa_ref_number AS source_dep_ref,
                target_dep.step AS target_dep_step,
                target_dep.status AS target_dep_status,
                target_dep.medusa_ref_number AS target_dep_ref
            FROM qb_order_pipeline p
            LEFT JOIN "order" ord ON ord.id = p.order_id
            LEFT JOIN pos_credit_memo cm ON p.reference_type = 'credit_memo' AND cm.id = p.reference_id
            LEFT JOIN "order" cm_ord ON cm_ord.id = cm.order_id
            LEFT JOIN qb_order_pipeline dep ON dep.id = p.depends_on
            -- apply_payment rows may key reference_id on the payment_application id
            -- (current convention, reference_type='payment_application') or directly
            -- on the customer_payment id (legacy). Resolve the application first so the
            -- SOURCE/TARGET joins below work for both shapes (COALESCE fallbacks).
            LEFT JOIN payment_application pa_ref
                ON p.step = 'apply_payment'
                AND p.reference_type = 'payment_application'
                AND pa_ref.id = p.reference_id
            -- apply_payment SOURCE: cpay → its payment OR credit_memo pipeline row
            LEFT JOIN customer_payment cp_src
                ON p.step = 'apply_payment'
                AND cp_src.id = COALESCE(pa_ref.payment_id, p.reference_id)
            LEFT JOIN pos_credit_memo cm_for_cp
                ON cp_src.type = 'credit_memo'
                AND cm_for_cp.credit_memo_number = cp_src.reference
            LEFT JOIN qb_order_pipeline source_dep
                ON p.step = 'apply_payment'
                AND (
                  (cp_src.type = 'credit_memo'
                    AND source_dep.step = 'credit_memo'
                    AND source_dep.reference_id = cm_for_cp.id)
                  OR
                  (cp_src.type IS DISTINCT FROM 'credit_memo'
                    AND source_dep.step = 'payment'
                    AND source_dep.reference_id = cp_src.id)
                )
            -- apply_payment TARGET: cpay → invoice via payment_application.
            -- LATERAL keeps the join 1:1 even if a cpay was applied to multiple
            -- invoices (most-recent non-voided application wins).
            LEFT JOIN LATERAL (
              SELECT invoice_id
                FROM payment_application
               WHERE payment_id = p.reference_id
                 AND voided_at IS NULL
               ORDER BY applied_at DESC NULLS LAST
               LIMIT 1
            ) papp ON p.step = 'apply_payment'
            LEFT JOIN qb_order_pipeline target_dep
                ON p.step = 'apply_payment'
                AND target_dep.step = 'invoice'
                AND target_dep.reference_id = COALESCE(pa_ref.invoice_id, papp.invoice_id)
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
      : salesPipelineStepScopeSql(1);
    const summaryValues: unknown[] = step
      ? [step]
      : [SALES_PIPELINE_EXCLUDED_STEPS];
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
