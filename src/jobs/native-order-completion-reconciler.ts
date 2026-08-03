import type { MedusaContainer } from "@medusajs/framework/types";

import { reconcileNativeOrderCompletions } from "../lib/order-completion/reconciler";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[native-order-completion-reconciler]";

/**
 * Five-minute safety net for an eligibility edge lost after its database write.
 * Disabled by default so its first production apply remains an explicit rollout
 * decision: ORDER_COMPLETION_RECONCILER_ENABLED=true.
 */
export default async function nativeOrderCompletionReconciler(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (process.env.ORDER_COMPLETION_RECONCILER_ENABLED !== "true") return;

  const logger = container.resolve("logger") as {
    info: (message: string) => void;
    warn: (message: string) => void;
  };

  try {
    const result = await reconcileNativeOrderCompletions(container, {
      source: "scheduled_reconciler",
      minAgeSeconds: 90,
      limit: 100,
    });
    const skipped = result.results.length - result.completed;
    if (result.candidates.length > 0) {
      const reasons = result.results.reduce<Record<string, number>>(
        (counts, entry) => {
          const reason = entry.result.reason ?? "completed";
          counts[reason] = (counts[reason] ?? 0) + 1;
          return counts;
        },
        {}
      );
      logger.warn(
        `${TAG} candidates=${result.candidates.length} completed=${result.completed} skipped=${skipped} outcomes=${JSON.stringify(reasons)}`
      );
    }
  } catch (error: unknown) {
    logger.warn(`${TAG} failed: ${(error as Error).message}`);
  }
}

export const config = {
  name: "native-order-completion-reconciler",
  schedule: "*/5 * * * *",
};
