import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  runPendingDispatchPass,
  runWakeDependentsPass,
  runOrphanedWaitingPass,
} from "../lib/quickbooks/consolidator/dispatch-pass";

const LOG_PREFIX = "[QB-DISPATCHER]";

/**
 * Standalone dispatch job (Workstream B — decoupling, the safe subset of
 * "Refactor B").
 *
 * WHY THIS EXISTS — dispatching a MOD does a synchronous bridge poll to fetch
 * the current EditSequence before submitting (pollRawOperationResult, up to
 * ~400s when QBWC is pathologically slow). While that runs, a single consolidator
 * tick was blocked, and because Medusa doesn't overlap a job with itself, the
 * NEXT tick — which would run cleanup, recovery (incl. B2 orphan recovery), and
 * customer passes — got skipped. The submitted-poller (B1) was already split out;
 * this splits dispatch out too, so the consolidator's fast phases (recovery,
 * customer, cleanup) and B1 keep running every minute regardless of how long a
 * dispatch takes.
 *
 * Order within this job mirrors the consolidator's old Phase D: orphan-rescue
 * first so a promoted waiting row is dispatched in the same run, then pending
 * dispatch, then wake-dependents.
 *
 * NOTE: this does NOT make the dispatch itself non-blocking — a slow MOD still
 * blocks THIS job (so a brand-new pending row may wait one slow cycle). Fully
 * removing that requires decoupling submit from the EditSequence-fetch poll
 * (a deliberate future refactor, not a pending bug).
 */
export default async function qbPipelineDispatcher(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return;

  try {
    await runOrphanedWaitingPass(logger);
    await runPendingDispatchPass(container, logger);
    await runWakeDependentsPass(container, logger);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${LOG_PREFIX} dispatch run failed: ${msg}`);
  }
}

export const config = {
  name: "qb-pipeline-dispatcher",
  schedule: "*/1 * * * *", // every minute, independent of the consolidator
};
