/**
 * MeiliSearch reconciliation cron — runs every 5 minutes.
 *
 * Walks each registered entity reconciler, finds rows updated in the last
 * 6 minutes (overlap with the cron interval to catch boundary cases),
 * compares DB ↔ Meili, repairs drift, and audit-logs every fix to
 * `meilisearch_drift_log`.
 *
 * This is the systemic answer to "we keep getting MeiliSearch desync" —
 * 68 direct SQL UPDATE statements in this codebase bypass the event bus
 * and the subscriber never fires. The cron catches them all, regardless
 * of how the write was performed.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import postgres from "postgres";
import { reconcileEntity, type ReconcilerStats } from "../lib/meilisearch/drift-reconciler";
import { customerReconciler } from "../lib/meilisearch/reconcilers/customer-reconciler";
import { productReconciler } from "../lib/meilisearch/reconcilers/product-reconciler";

export const config = {
  name: "meilisearch-reconciliation",
  // Every 5 minutes. Window is 6 min so the next pass catches anything the
  // previous one might have missed at the boundary.
  schedule: "*/5 * * * *",
};

const RECONCILERS = [customerReconciler, productReconciler];

/** Cap on rows scanned per entity per pass — protects against runaway. */
const MAX_ROWS_PER_PASS = 500;
/** Lookback window. Must be > cron interval to avoid boundary misses. */
const WINDOW_MINUTES = 6;

export default async function meilisearchReconciliationCron(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };

  if (!process.env.MEILISEARCH_HOST || !process.env.MEILISEARCH_API_KEY) {
    logger.info("[meili-reconcile] skipped — MeiliSearch env vars missing");
    return;
  }

  const sinceIso = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  const allStats: ReconcilerStats[] = [];

  try {
    for (const reconciler of RECONCILERS) {
      try {
        const stats = await reconcileEntity(reconciler, sql, container, {
          sinceIso,
          maxRows: MAX_ROWS_PER_PASS,
          dryRun: false,
          logger,
        });
        allStats.push(stats);
      } catch (err: unknown) {
        logger.error(
          `[meili-reconcile] ${reconciler.entityType} pass crashed: ${
            (err as Error).message
          }`
        );
      }
    }
  } finally {
    await sql.end();
  }

  // Single concise summary line per cron pass — easy to grep in Railway logs.
  const summary = allStats
    .map(
      (s) =>
        `${s.entityType}={checked:${s.checked},drifted:${s.drifted},fixed:${s.fixed},err:${s.fix_errors}}`
    )
    .join(" ");
  if (allStats.some((s) => s.drifted > 0 || s.fix_errors > 0)) {
    logger.warn(`[meili-reconcile] ${summary}`);
  } else if (allStats.some((s) => s.checked > 0)) {
    logger.info(`[meili-reconcile] ${summary}`);
  }
}
