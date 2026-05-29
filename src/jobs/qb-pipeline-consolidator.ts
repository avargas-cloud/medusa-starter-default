import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";
import {
  runCustomerPass,
  runCustomerDataExtPass,
} from "../lib/quickbooks/consolidator/customer-pass";
import {
  runPendingDispatchPass,
  runWakeDependentsPass,
  runOrphanedWaitingPass,
} from "../lib/quickbooks/consolidator/dispatch-pass";
import {
  pollSubmittedRows,
  type SubmittedRow,
} from "../lib/quickbooks/consolidator/poll-submitted-rows";
import {
  runRefundPaymentRecovery,
  runSoToggleRecovery,
  runOrphanedProcessingRecovery,
} from "../lib/quickbooks/consolidator/recovery-pass";
import {
  runTimeoutPass,
  runStaleSubmittedCleanup,
  runStalePendingCleanup,
} from "../lib/quickbooks/consolidator/stale-cleanup-pass";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Runs every minute.
 * Orchestrates all QB pipeline passes in sequence:
 *   Phase A — poll submitted bridge ops (confirm / fail)
 *   Phase B — recovery passes for orphaned rows
 *   Phase C — customer + data-ext creation passes
 *   Phase D — pending dispatch + wake-dependents passes
 *   Phase E — stale / timeout cleanup passes
 */
export default async function qbPipelineConsolidator(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return;

  const pool = getDbPool();

  // ── Phase A: poll submitted rows ───────────────────────────────────────────
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

  // NOTE: No early return here — the passes below must always run even when
  // there are no submitted rows to poll.
  if (submittedRows.length > 0) {
    logger.info(
      `${LOG_PREFIX} Polling ${submittedRows.length} submitted operations...`
    );
  }

  await pollSubmittedRows(submittedRows, container, logger);

  // ── Phase B: recovery passes ───────────────────────────────────────────────
  await runRefundPaymentRecovery(logger);
  await runSoToggleRecovery(logger);
  // Re-queue idempotent-step rows orphaned in 'processing' by a mid-dispatch
  // reset (>8 min) so Phase D below re-dispatches them this same tick.
  await runOrphanedProcessingRecovery(logger);

  // ── Phase C: customer creation passes ─────────────────────────────────────
  await runCustomerPass(container, logger);
  await runCustomerDataExtPass(container, logger);

  // ── Phase D: dispatch pending + wake waiting rows ──────────────────────────
  // Orphan rescue first so any promoted row is dispatched within the same tick.
  await runOrphanedWaitingPass(logger);
  await runPendingDispatchPass(container, logger);
  await runWakeDependentsPass(container, logger);

  // ── Phase E: stale / timeout cleanup ──────────────────────────────────────
  await runTimeoutPass(logger);
  await runStaleSubmittedCleanup(logger);
  await runStalePendingCleanup(logger);
}

export const config = {
  name: "qb-pipeline-consolidator",
  schedule: "*/1 * * * *", // TODO: change back to */2 after testing
};
