import { getDbPool } from "../../api/utils/db-pool";

import type { PipelineStatus, PipelineStep } from "./qb-pipeline";

export interface PrimaryPipelineRow {
  id: string;
  status: PipelineStatus;
  step: PipelineStep;
  retry_count: number;
  qb_txn_id: string | null;
  qb_ref_number: string | null;
  medusa_ref_number: string | null;
  error: string | null;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
}

export interface GetPrimaryPipelineRowInput {
  referenceId?: string | null;
  orderId?: string | null;
  step: PipelineStep | PipelineStep[];
}

/**
 * Maps each sales CREATE step to its append-only mutation steps (2026-08-06).
 * "The state of this document's sync" now means "the most recent OPERATION on
 * it" — a caller asking for `estimate` must also see `estimate_mod` rows, or
 * the POS QB SYNC button would keep reporting the ADD's confirm while an edit
 * is failing.
 */
const COMPANION_MOD_STEPS: Partial<Record<string, PipelineStep[]>> = {
  estimate: ["estimate_mod"],
  sales_order: ["sales_order_mod"],
  invoice: ["invoice_update"],
  sales_receipt: ["sales_receipt_update"],
  credit_memo: ["credit_memo_mod"],
};

/**
 * Returns the most recent qb_order_pipeline row for a document, matching by
 * reference_id and/or order_id, for the given step (or any of the given steps).
 * Sales create steps implicitly include their append-only mod steps.
 * Used by the POS to decide the state of the "QB SYNC" button.
 */
export async function getPrimaryPipelineRow(
  input: GetPrimaryPipelineRowInput
): Promise<PrimaryPipelineRow | null> {
  const { referenceId, orderId } = input;
  if (!referenceId && !orderId) return null;

  const requested = Array.isArray(input.step) ? input.step : [input.step];
  if (requested.length === 0) return null;
  const steps = [
    ...new Set(
      requested.flatMap((s) => [s, ...(COMPANION_MOD_STEPS[s] ?? [])])
    ),
  ];

  const pool = getDbPool();
  // Tie-break by seq (monotonic insert counter, same as the feed): batch
  // inserts share a single NOW() so created_at alone is not a total order —
  // without it, two runs can return different rows and the POS button
  // flickers between states (same failure the feed had pre-seq).
  const { rows } = await pool.query<PrimaryPipelineRow>(
    `SELECT id, status, step, retry_count,
            qb_txn_id, qb_ref_number, medusa_ref_number,
            error, created_at, submitted_at, confirmed_at, failed_at
       FROM qb_order_pipeline
       WHERE step = ANY($1::text[])
         AND (
           ($2::text IS NOT NULL AND reference_id = $2::text)
           OR ($3::text IS NOT NULL AND order_id = $3::text)
         )
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    [steps, referenceId ?? null, orderId ?? null]
  );
  return rows[0] ?? null;
}
