/**
 * requeue-stale-po-pipeline.ts
 *
 * One-shot recovery: moves qb_purchase_order_pipeline rows from
 * `failed_permanent` back to `error` (next_retry_at = NOW()) when their
 * `last_error` matches a recoverable QB-side condition:
 *
 *   - "PO not found in QB ... may have been deleted"  (TxnID query mismatch)
 *   - EditSequence errors (3100/3200, "EditSequence")
 *
 * The poller's new RefNumber fallback (qb-purchase-order-poller.ts) handles
 * these conditions automatically going forward. This script is just to thaw
 * existing failed_permanent rows so they re-enter the cron's recovery path.
 *
 * Read-only by default. Set APPLY=true to actually update.
 *
 * Usage (from backend/):
 *   yarn medusa exec src/scripts/fix/requeue-stale-po-pipeline.ts                  # dry-run
 *   APPLY=true yarn medusa exec src/scripts/fix/requeue-stale-po-pipeline.ts       # apply
 *   PIPELINE_IDS=qbpopipe_X,qbpopipe_Y APPLY=true yarn medusa exec ...             # specific ids only
 */

import type { MedusaContainer } from "@medusajs/framework/types";

interface CandidateRow {
  id: string;
  purchase_order_id: string;
  status: string;
  retries: number;
  last_error: string | null;
  updated_at: Date | string;
}

const RECOVERABLE_RE =
  /editsequence|edit.?sequence|3[12]00|po not found in qb|may have been deleted/i;

export default async function requeueStalePoPipeline({
  container,
}: {
  container: MedusaContainer;
}) {
  const knex = (
    container as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }
  ).resolve("__pg_connection__");

  const apply = process.env.APPLY === "true";
  const idsFilter = (process.env.PIPELINE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("=== requeue-stale-po-pipeline ===");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (idsFilter.length > 0) {
    console.log(`Filter ids: ${idsFilter.join(", ")}`);
  }
  console.log("");

  const params: unknown[] = [];
  let where = `status = 'failed_permanent' AND deleted_at IS NULL`;
  if (idsFilter.length > 0) {
    where += ` AND id = ANY(?)`;
    params.push(idsFilter);
  }

  const rows = (
    await knex.raw(
      `SELECT id, purchase_order_id, status, retries, last_error, updated_at
         FROM qb_purchase_order_pipeline
        WHERE ${where}
        ORDER BY updated_at DESC`,
      params
    )
  ).rows as CandidateRow[];

  if (rows.length === 0) {
    console.log("No failed_permanent rows match filter — nothing to do.");
    return;
  }

  const recoverable: CandidateRow[] = [];
  const skipped: CandidateRow[] = [];
  for (const r of rows) {
    if (RECOVERABLE_RE.test(r.last_error ?? "")) {
      recoverable.push(r);
    } else {
      skipped.push(r);
    }
  }

  console.log(`Found ${rows.length} failed_permanent rows`);
  console.log(`  Recoverable (matching pattern): ${recoverable.length}`);
  console.log(`  Skipped (other errors):         ${skipped.length}`);
  console.log("");

  if (recoverable.length > 0) {
    console.log("─── Recoverable rows ───");
    for (const r of recoverable) {
      console.log(
        `  ${r.id}  po=${r.purchase_order_id}  retries=${r.retries}`
      );
      console.log(`    err: ${(r.last_error ?? "").slice(0, 180)}`);
    }
    console.log("");
  }

  if (skipped.length > 0) {
    console.log("─── Skipped (manual review) ───");
    for (const r of skipped) {
      console.log(
        `  ${r.id}  po=${r.purchase_order_id}  retries=${r.retries}`
      );
      console.log(`    err: ${(r.last_error ?? "").slice(0, 180)}`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("Dry-run only. Re-run with APPLY=true to update.");
    return;
  }

  if (recoverable.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  const ids = recoverable.map((r) => r.id);
  await knex.raw(
    `UPDATE qb_purchase_order_pipeline
        SET status         = 'error',
            retries        = 0,
            qb_operation_id = NULL,
            next_retry_at  = NOW(),
            payload        = (payload - '_query_attempts' - '_refnumber_recovery_attempts')
                              || jsonb_build_object('is_query', true, 'edit_sequence', null),
            updated_at     = NOW()
      WHERE id = ANY(?)
        AND status = 'failed_permanent'`,
    [ids]
  );

  console.log(`Re-queued ${ids.length} rows to status='error'.`);
  console.log(
    `Cron qb-purchase-order-poller will pick them up within ~1 minute.`
  );
}
