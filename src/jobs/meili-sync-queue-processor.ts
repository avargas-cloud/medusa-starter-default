/**
 * MeiliSearch sync queue processor — Capa 2 of the 3-tier sync architecture.
 *
 * Architecture:
 *   1. Postgres trigger on `customer` (and later product/order/etc.) enqueues
 *      a row into `meili_sync_queue` on every INSERT/UPDATE/DELETE.
 *   2. This worker pulls pending rows every 1 minute, DEDUPES by entity_id
 *      (last queued wins — we always sync the current DB state), and calls
 *      the reconciler's syncOne for each unique entity.
 *   3. On success → marks all dedup'd rows for that entity as processed.
 *      On failure → records error + increments attempt_count.
 *
 * Why dedup matters: if 10 SQL updates hit the same customer in 30 seconds,
 * the trigger enqueues 10 rows. The worker syncs to Meili ONCE (with the
 * latest DB state), saving 9 round trips while still being correct.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import postgres from "postgres";
import type { EntityReconciler } from "../lib/meilisearch/drift-reconciler";
import { customerReconciler } from "../lib/meilisearch/reconcilers/customer-reconciler";
import { productReconciler } from "../lib/meilisearch/reconcilers/product-reconciler";
import { inventoryReconciler } from "../lib/meilisearch/reconcilers/inventory-reconciler";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
export const config = {
  name: "meili-sync-queue-processor",
  schedule: "*/1 * * * *", // Every 1 minute — Medusa cron's minimum.
};

/** entity_type → reconciler. Add order/pos_invoice etc. here as
 *  their triggers are wired up. The `inventory_item` key matches the
 *  entity_type enqueued by the inventory_level trigger (AddInventoryMeiliSyncTriggers). */
const RECONCILERS: Record<string, EntityReconciler> = {
  customer: customerReconciler,
  product: productReconciler,
  inventory_item: inventoryReconciler,
};

/** Max rows pulled per pass — safety cap, won't process more than this even
 *  if the backlog is huge. The next pass picks up the rest. */
const BATCH_SIZE = 500;
/** Skip rows that have already failed this many times — they go to a
 *  dead-letter style state (still in queue, but not retried). */
const MAX_ATTEMPTS = 5;

interface QueueRow {
  id: string; // bigint as string from postgres.js
  entity_type: string;
  entity_id: string;
  op: string;
  attempt_count: number;
  source_hint: string | null;
}

export default async function meiliSyncQueueProcessor(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };

  if (!process.env.MEILISEARCH_HOST || !process.env.MEILISEARCH_API_KEY) {
    return; // No-op when Meili isn't configured (preview / local without Meili).
  }

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 2,
    connection: { application_name: "meili-sync-worker" },
  });

  try {
    // Claim a batch with FOR UPDATE SKIP LOCKED so multiple workers (e.g.
    // shared + worker modes) never double-process the same row.
    const claimed = await sql<QueueRow[]>`
      WITH claimable AS (
        SELECT id
        FROM meili_sync_queue
        WHERE processed_at IS NULL
          AND attempt_count < ${MAX_ATTEMPTS}
        ORDER BY queued_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE meili_sync_queue q
      SET attempt_count = attempt_count + 1
      FROM claimable c
      WHERE q.id = c.id
      RETURNING q.id::text, q.entity_type, q.entity_id, q.op, q.attempt_count, q.source_hint
    `;

    if (claimed.length === 0) return;

    // ── Dedup pass — last write wins per (entity_type, entity_id) ──────
    // Group by entity, keep ALL row ids for that entity so we can mark
    // them all processed in one shot when the sync succeeds.
    const groups = new Map<
      string,
      { entity_type: string; entity_id: string; queueRowIds: string[]; op: string }
    >();
    for (const row of claimed) {
      const key = `${row.entity_type}:${row.entity_id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.queueRowIds.push(row.id);
        existing.op = row.op; // last wins
      } else {
        groups.set(key, {
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          queueRowIds: [row.id],
          op: row.op,
        });
      }
    }

    const stats = { synced: 0, deleted: 0, skipped: 0, errors: 0 };

    for (const group of groups.values()) {
      const reconciler = RECONCILERS[group.entity_type];
      if (!reconciler) {
        // Unknown entity_type — mark as processed so we don't loop on it.
        await sql`
          UPDATE meili_sync_queue
          SET processed_at = NOW(), last_error = ${"no reconciler registered"}
          WHERE id = ANY(${group.queueRowIds}::bigint[])
        `;
        stats.skipped++;
        continue;
      }

      try {
        if (group.op === "DELETE") {
          // Delete the doc from Meili rather than re-syncing
          const { MeiliSearch } = await import("meilisearch");
          const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
          });
          await client
            .index(reconciler.meiliIndex)
            .deleteDocument(group.entity_id);
          stats.deleted++;
        } else {
          await reconciler.syncOne(group.entity_id, container);
          stats.synced++;
        }
        await sql`
          UPDATE meili_sync_queue
          SET processed_at = NOW(), last_error = NULL
          WHERE id = ANY(${group.queueRowIds}::bigint[])
        `;
      } catch (err: unknown) {
        stats.errors++;
        const msg = (err as Error).message;
        await sql`
          UPDATE meili_sync_queue
          SET last_error = ${msg}
          WHERE id = ANY(${group.queueRowIds}::bigint[])
        `;
        logger.error(
          `[meili-queue] sync failed for ${group.entity_type}:${group.entity_id}: ${msg}`
        );
      }
    }

    // Single concise summary line per pass — easy to grep.
    logger.info(
      `[meili-queue] claimed=${claimed.length} groups=${groups.size} synced=${stats.synced} deleted=${stats.deleted} skipped=${stats.skipped} errors=${stats.errors}`
    );

    // Dead-letter alert: rows that exhausted all retries stay in the queue
    // with processed_at=NULL forever. Log a warning so ops can investigate.
    const deadRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM meili_sync_queue
      WHERE processed_at IS NULL
        AND attempt_count >= ${MAX_ATTEMPTS}
    `;
    const deadCount = parseInt(deadRows[0]?.count ?? "0", 10);
    if (deadCount > 0) {
      logger.warn(
        `[meili-queue] ⚠️  ${deadCount} dead-letter row(s) stuck (attempt_count >= ${MAX_ATTEMPTS}, processed_at IS NULL) — manual investigation required`
      );
    }
  } finally {
    await sql.end();
  }
}
