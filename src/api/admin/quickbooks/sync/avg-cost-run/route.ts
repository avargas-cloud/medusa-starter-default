import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { MedusaContainer } from "@medusajs/framework/types";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";
import {
  syncAverageCostCore,
  type AvgCostSyncScope,
} from "../../../../../lib/quickbooks/sync-average-cost-core";

/**
 * POST /admin/quickbooks/sync/avg-cost-run
 * GET  /admin/quickbooks/sync/avg-cost-run   → latest run (for polling)
 *
 * Durable, poll-based average-cost sync backing the POS QuickBooks "Cost Sync"
 * tab. The POST enqueues a qb_avg_cost_sync_run row and drives the work inline
 * via setImmediate (not a cron — so it runs under ./back and in prod alike),
 * writing progress counters to the row as it goes. The POS card polls GET every
 * 3s with a Bearer token (no SSE — native EventSource can't attach auth).
 *
 * Body: { scope?: 'all' | 'non_china', dry_run?: boolean } (scope default 'non_china').
 */

const ACTIVE_STATUSES = ["queued", "fetching", "processing"];
const VALID_SCOPES: AvgCostSyncScope[] = ["all", "non_china"];
// A run whose row hasn't advanced in this long is assumed dead (process died
// mid-sync) — the guard fails it so the button never wedges on a stuck run.
const STALE_MS = 15 * 60 * 1000;

type SyncRunRow = {
  id: string;
  status: string;
  scope: string;
  total_count: number;
  processed_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  error_count: number;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  last_error: string | null;
  triggered_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

interface CatalogService {
  createQbAvgCostSyncRuns(data: Partial<SyncRunRow>): Promise<SyncRunRow>;
  updateQbAvgCostSyncRuns(
    data: Partial<SyncRunRow> & { id: string }
  ): Promise<SyncRunRow>;
  listQbAvgCostSyncRuns(
    filter?: Record<string, unknown>,
    config?: { order?: Record<string, "ASC" | "DESC">; take?: number }
  ): Promise<SyncRunRow[]>;
}

function getCatalog(container: MedusaContainer): CatalogService {
  return container.resolve(
    QUICKBOOKS_CATALOG_MODULE
  ) as unknown as CatalogService;
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const catalog = getCatalog(req.scope);
  const rows = await catalog.listQbAvgCostSyncRuns(
    {},
    { order: { created_at: "DESC" }, take: 1 }
  );
  res.json({ run: rows[0] ?? null });
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const container = req.scope;
  const catalog = getCatalog(container);

  const body = (req.body ?? {}) as { scope?: string; dry_run?: boolean };
  const scope: AvgCostSyncScope =
    body.scope === undefined ? "non_china" : (body.scope as AvgCostSyncScope);
  if (!VALID_SCOPES.includes(scope)) {
    res.status(400).json({
      error: `Invalid scope '${body.scope}'. Must be one of: ${VALID_SCOPES.join(", ")}`,
    });
    return;
  }
  const dryRun = !!body.dry_run;

  // Concurrency + stale guard: at most one active run. A stale active run is
  // marked failed (not blocking) so a dead process can't wedge the button.
  const active = await catalog.listQbAvgCostSyncRuns(
    { status: ACTIVE_STATUSES },
    { order: { created_at: "DESC" }, take: 5 }
  );
  for (const run of active) {
    const age = Date.now() - new Date(run.updated_at).getTime();
    if (age > STALE_MS) {
      await catalog.updateQbAvgCostSyncRuns({
        id: run.id,
        status: "failed",
        last_error: "Run went stale (no progress) — auto-failed.",
        completed_at: new Date(),
      });
    } else {
      res.status(409).json({
        error: "An average-cost sync is already running.",
        run,
      });
      return;
    }
  }

  const userId =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? null;

  const run = await catalog.createQbAvgCostSyncRuns({
    status: "queued",
    scope,
    triggered_by_user_id: userId,
    started_at: new Date(),
  });

  res.status(202).json({ run });

  // Drive the sync in the background; progress is written to the run row.
  setImmediate(async () => {
    try {
      await catalog.updateQbAvgCostSyncRuns({ id: run.id, status: "fetching" });

      const result = await syncAverageCostCore(container, {
        scope,
        dryRun,
        onProgress: async (p) => {
          await catalog.updateQbAvgCostSyncRuns({
            id: run.id,
            status: p.phase,
            total_count: p.total,
            processed_count: p.processed,
            updated_count: p.updated,
            unchanged_count: p.unchanged,
            skipped_count: p.skipped,
          });
        },
      });

      if (result.success) {
        const s = result.stats;
        await catalog.updateQbAvgCostSyncRuns({
          id: run.id,
          status: "completed",
          total_count: s.totalLinkedVariants,
          processed_count: s.totalLinkedVariants,
          updated_count: s.updatedAverageCost,
          unchanged_count: s.skippedNoChange,
          skipped_count: s.skippedNoAverageCost + s.missingInQb,
          error_count: 0,
          completed_at: new Date(),
          last_error: null,
        });
      } else {
        await catalog.updateQbAvgCostSyncRuns({
          id: run.id,
          status: "failed",
          last_error: result.error ?? "Unknown error",
          completed_at: new Date(),
        });
      }
    } catch (err) {
      await catalog
        .updateQbAvgCostSyncRuns({
          id: run.id,
          status: "failed",
          last_error: (err as Error).message,
          completed_at: new Date(),
        })
        .catch(() => {});
    }
  });
}
