import { MedusaContainer } from "@medusajs/framework/types";

import { bridgeFetch } from "../lib/quickbooks/client/core";

/**
 * Nightly auto-purge of the QB Web Connector bridge queue history.
 *
 * The bridge keeps a lifetime log of completed/failed ops (SQLite on the
 * Windows VM). Counts shown on the "QB Bridge Status" admin card are
 * pulled from that log and grow indefinitely until someone hits "Purge
 * History" manually, which makes the card look perpetually out of date.
 *
 * Safety guard: we only purge if `pending == 0 && processing == 0`. If
 * there's anything queued or in-flight, skip and try again tomorrow —
 * better to show stale numbers than wipe a row the bridge is about to
 * process.
 */

type BridgeStats = {
  pending?: number;
  processing?: number;
  completed?: number;
  failed?: number;
  total?: number;
};

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : parseInt(String(value ?? 0), 10);
  return Number.isFinite(n) ? n : 0;
};

export default async function qbBridgeAutoPurge(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve("logger");

  let stats: BridgeStats;
  try {
    stats = (await bridgeFetch("GET", "/api/sync/queue-stats")) as BridgeStats;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[qb-bridge-auto-purge] could not read bridge stats: ${message}`);
    return;
  }

  const pending = num(stats.pending);
  const processing = num(stats.processing);
  const completed = num(stats.completed);
  const failed = num(stats.failed);
  const total = num(stats.total);

  if (pending > 0 || processing > 0) {
    logger.info(
      `[qb-bridge-auto-purge] skip — bridge still has work in flight ` +
        `(pending=${pending}, processing=${processing}, completed=${completed}, failed=${failed})`
    );
    return;
  }

  if (total === 0) {
    logger.info("[qb-bridge-auto-purge] skip — bridge history already empty");
    return;
  }

  try {
    await bridgeFetch("POST", "/api/sync/queue/purge");
    logger.info(
      `[qb-bridge-auto-purge] purged bridge history ` +
        `(completed=${completed}, failed=${failed}, total=${total})`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[qb-bridge-auto-purge] purge call failed: ${message}`);
  }
}

/**
 * Daily at 03:30 server time. Sits in the same quiet window as the other
 * QB maintenance jobs, after the nightly digests have run.
 */
export const config = {
  name: "qb-bridge-auto-purge",
  schedule: "30 3 * * *",
};
