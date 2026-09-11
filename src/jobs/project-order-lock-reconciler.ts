import type { MedusaContainer } from "@medusajs/framework/types";

import { isProjectLockDisabled, reconcileProjectOrderLocks } from "../lib/project-lock";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[project-order-lock-reconciler]";

/**
 * Red de seguridad de cinco minutos del candado proyecto ↔ orden. Encendido
 * por default (el candado es una regla de negocio que ya rige en el POS);
 * PROJECT_LOCK_DISABLED=true lo apaga junto con el subscriber.
 */
export default async function projectOrderLockReconciler(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (isProjectLockDisabled()) return;

  const logger = container.resolve("logger") as {
    info: (message: string) => void;
    warn: (message: string) => void;
  };

  try {
    const summary = await reconcileProjectOrderLocks({ limit: 200, createdBy: "reconciler" });
    if (summary.candidates > 0) {
      logger.info(
        `${TAG} candidates=${summary.candidates} locked=${summary.locked} ` +
          `unpaid=${summary.results.filter((r) => r.reason === null).length}`
      );
    }
  } catch (error: unknown) {
    logger.warn(`${TAG} failed: ${(error as Error).message}`);
  }
}

export const config = {
  name: "project-order-lock-reconciler",
  schedule: "*/5 * * * *",
};
