import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";
import {
  pollSubmittedRows,
  type SubmittedRow,
} from "../lib/quickbooks/consolidator/poll-submitted-rows";

const LOG_PREFIX = "[QB-SUBMITTED-POLLER]";

/**
 * Standalone submitted-rows poller (Workstream B1).
 *
 * WHY THIS EXISTS — the main `qb-pipeline-consolidator` runs Phase A (confirm
 * submitted rows) and Phase D (dispatch) in the SAME job. Dispatching a MOD does
 * a synchronous bridge poll (`pollOperationResult`, up to ~400s). Because Medusa
 * does not overlap instances of the same scheduled job, a tick stuck for minutes
 * in Phase D starves Phase A — so rows whose bridge op is ALREADY `completed`
 * sit in `submitted` for many minutes, and a server reset mid-poll leaves them
 * unconfirmed until stale-cleanup.
 *
 * This job runs Phase A on its OWN schedule, decoupled from dispatch. Node's
 * event loop is not blocked by the consolidator's `await` on bridge polls, so
 * this poller keeps confirming submitted rows every minute regardless of how
 * long a dispatch is taking — i.e. it "revives" stalled polling and survives
 * server resets. Confirmation is CAS (`confirmPipelineRow` guards on
 * `status <> 'confirmed'`), so racing the consolidator's Phase A is harmless:
 * only one run confirms and wakes dependents.
 */
export default async function qbPipelineSubmittedPoller(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return;

  const pool = getDbPool();

  let submittedRows: SubmittedRow[];
  try {
    const { rows } = await pool.query(`
      SELECT id, order_id, reference_id, reference_type, step, bridge_op_id, retry_count, qb_txn_id
      FROM qb_order_pipeline
      WHERE status = 'submitted'
        AND bridge_op_id IS NOT NULL
      ORDER BY COALESCE(updated_at, created_at) ASC
      LIMIT 50
    `);
    submittedRows = rows as SubmittedRow[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${LOG_PREFIX} Failed to query submitted rows: ${msg}`);
    return;
  }

  if (submittedRows.length === 0) return;

  logger.info(
    `${LOG_PREFIX} Polling ${submittedRows.length} submitted operation(s)...`
  );
  await pollSubmittedRows(submittedRows, container, logger);
}

export const config = {
  name: "qb-pipeline-submitted-poller",
  schedule: "*/1 * * * *", // every minute, independent of the consolidator
};
