import { MedusaContainer } from "@medusajs/framework/types";

/**
 * Local dev (`./back`) shares DATABASE_URL + QB_BRIDGE_URL with the real Railway
 * deployment — without this guard every job here fires redundantly against
 * production from local dev/nodemon restarts. `dev.sh` sets
 * DISABLE_SCHEDULED_JOBS=true so only Railway runs these.
 */
export function isScheduledJobsDisabled(container: MedusaContainer): boolean {
  if (process.env.DISABLE_SCHEDULED_JOBS !== "true") return false;
  try {
    container
      .resolve("logger")
      .debug("[scheduled-jobs] DISABLE_SCHEDULED_JOBS=true — skipping (local dev)");
  } catch {
    // logger not resolvable — still skip, just silently
  }
  return true;
}
