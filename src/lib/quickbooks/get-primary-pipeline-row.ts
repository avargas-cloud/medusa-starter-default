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
 * Returns the most recent qb_order_pipeline row for a document, matching by
 * reference_id and/or order_id, for the given step (or any of the given steps).
 * Used by the POS to decide the state of the "QB SYNC" button.
 */
export async function getPrimaryPipelineRow(
  input: GetPrimaryPipelineRowInput
): Promise<PrimaryPipelineRow | null> {
  const { referenceId, orderId } = input;
  if (!referenceId && !orderId) return null;

  const steps = Array.isArray(input.step) ? input.step : [input.step];
  if (steps.length === 0) return null;

  const pool = getDbPool();
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
       ORDER BY created_at DESC
       LIMIT 1`,
    [steps, referenceId ?? null, orderId ?? null]
  );
  return rows[0] ?? null;
}
