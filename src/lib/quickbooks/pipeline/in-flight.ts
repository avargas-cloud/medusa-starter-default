import { getDbPool } from "../../../api/utils/db-pool";
import type { PipelineStep, PipelineStatus } from "./types";

/**
 * Looks up a submitted pipeline row by bridge_op_id.
 * Used by the consolidator cron to match poll results back to rows.
 */
export async function findSubmittedRowByOpId(bridgeOpId: string): Promise<{
  id: string;
  orderId: string | null;
  referenceId: string | null;
  step: PipelineStep;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, order_id, reference_id, step
         FROM qb_order_pipeline
         WHERE bridge_op_id = $1 AND status = 'submitted'
         LIMIT 1`,
    [bridgeOpId]
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    orderId: rows[0].order_id,
    referenceId: rows[0].reference_id,
    step: rows[0].step,
  };
}

/**
 * Polls a pipeline row until it leaves the 'submitted' state (i.e. reaches confirmed/failed/skipped).
 * Used by QB lock callbacks to ensure save2 only starts after save1 is confirmed,
 * so it can pick up the freshly-cached EditSequence and skip the GET round-trip.
 *
 * Returns 'confirmed', 'failed', 'skipped', 'timeout', or 'stale' if the row has been
 * stuck in 'submitted' (>15 min) or 'pending' (>10 min) based on updated_at.
 */
export async function pollUntilQbConfirmed(
  rowId: string,
  maxWaitMs = 5 * 60 * 1000, // 5 minutes default
  intervalMs = 3000
): Promise<"confirmed" | "failed" | "skipped" | "timeout" | "stale"> {
  const pool = getDbPool();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT status, updated_at FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    );
    const row = rows[0] as { status: string; updated_at: string } | undefined;
    const status = row?.status;
    if (status === "confirmed") return "confirmed";
    if (status === "failed") return "failed";
    if (status === "skipped") return "skipped";

    // Stale detection: if the row has been stuck too long, don't wait forever
    if (row?.updated_at) {
      const updatedAt = new Date(row.updated_at).getTime();
      const ageMs = Date.now() - updatedAt;
      const isStaleSubmitted = status === "submitted" && ageMs > 15 * 60 * 1000;
      const isStalePending = status === "pending" && ageMs > 10 * 60 * 1000;
      if (isStaleSubmitted || isStalePending) {
        return "stale";
      }
    }

    // still 'submitted' or 'pending' — wait and retry
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return "timeout";
}

/**
 * Returns all in-flight (pending/processing/submitted/waiting) pipeline rows for the given order
 * matching the provided steps. Used to detect races between creation and void operations.
 */
export async function findInFlightQbRows(
  orderId: string,
  steps: PipelineStep[]
): Promise<Array<{ id: string; step: PipelineStep; status: PipelineStatus }>> {
  if (steps.length === 0) return [];
  const pool = getDbPool();
  const placeholders = steps.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await pool.query(
    `SELECT id, step, status FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN (${placeholders})
           AND status IN ('pending', 'processing', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
    [orderId, ...steps]
  );
  return rows.map((r) => ({
    id: r.id as string,
    step: r.step as PipelineStep,
    status: r.status as PipelineStatus,
  }));
}

/**
 * Marks a pipeline row as skipped by its UUID.
 * Use this to cancel a "waiting" or "pending" row that should never reach QB
 * (e.g. an estimate that was voided before the 1-hour cron window fired).
 */
export async function skipPipelineRowById(
  rowId: string,
  reason: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
         SET status = 'skipped',
             error  = $2
         WHERE id = $1
           AND status IN ('waiting', 'pending')`,
    [rowId, reason]
  );
}

/**
 * Returns all in-flight (pending/processing/submitted/waiting) pipeline rows matched by referenceId
 * and referenceType. Used for credit memos and other reference-keyed documents.
 */
export async function findInFlightQbRowsByRef(
  referenceId: string,
  referenceType: string,
  steps: PipelineStep[]
): Promise<Array<{ id: string; step: PipelineStep; status: PipelineStatus }>> {
  if (steps.length === 0) return [];
  const pool = getDbPool();
  const placeholders = steps.map((_, i) => `$${i + 3}`).join(", ");
  // `status` viaja además del id porque los callers lo reportan al operador:
  // "sigue en vuelo" es accionable sólo si dice EN QUÉ estado. Igual que el
  // findInFlightQbRows hermano, que ya lo devolvía.
  const { rows } = await pool.query(
    `SELECT id, step, status FROM qb_order_pipeline
         WHERE reference_id = $1
           AND reference_type = $2
           AND step IN (${placeholders})
           AND status IN ('pending', 'processing', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
    [referenceId, referenceType, ...steps]
  );
  return rows.map((r) => ({
    id: r.id as string,
    step: r.step as PipelineStep,
    status: r.status as PipelineStatus,
  }));
}

/**
 * Returns the id of the most recent in-flight (pending/processing/submitted/waiting) so_close or
 * so_reopen pipeline row for the given order, or null if none exists.
 * Used by toggle-close to create dependency chains and prevent race conditions.
 */
export async function findLastInFlightSoToggleRow(
  orderId: string
): Promise<string | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN ('so_close', 'so_reopen')
           AND status IN ('pending', 'processing', 'submitted', 'waiting')
         ORDER BY created_at DESC
         LIMIT 1`,
    [orderId]
  );
  return rows[0]?.id ?? null;
}

// ─── next_payload coalescing ─────────────────────────────────────────────────
//
// When a document is saved while a QB operation is already in-flight (submitted),
// we coalesce the new save instead of spawning a duplicate bridge call.
//
// Flow:
//   Save #1 → pending → submitted  (bridge processing)
//   Save #2 while submitted → next_payload = {coalescedAt} set on the same row
//                             → caller returns early, no bridge call
//   Consolidator confirms #1 → claimAndResetForResubmit → row reset to pending
//                             → appropriate handler called immediately
//   Row processes normally: pending → submitted → confirmed
//
// This keeps exactly 1 pipeline row per document at all times.

/**
 * Call at the start of every QB handler before touching the bridge.
 *
 * If a 'submitted' row already exists for this document+step:
 *   - Sets next_payload = {coalescedAt: <iso>} on that row (last-write-wins marker)
 *   - Returns true  → caller MUST return immediately without calling the bridge
 *
 * If no submitted row exists:
 *   - Returns false → caller proceeds normally
 *
 * Supports orderId-only, referenceId-only, or both (null-safe).
 */
export async function coalesceIfInFlight(
  orderId: string | null,
  referenceId: string | null,
  step: PipelineStep
): Promise<boolean> {
  if (!orderId && !referenceId) return false;
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
         SET next_payload = $3::jsonb,
             updated_at   = NOW()
         WHERE step   = $2
           AND status  = 'submitted'
           AND (
             ($1::text IS NOT NULL AND order_id = $1::text
               AND ($4::text IS NULL OR reference_id = $4::text))
             OR
             ($1::text IS NULL AND $4::text IS NOT NULL AND reference_id = $4::text)
           )
         RETURNING id`,
    [
      orderId ?? null,
      step,
      JSON.stringify({ coalescedAt: new Date().toISOString() }),
      referenceId ?? null,
    ]
  );
  return rows.length > 0;
}

/**
 * Called by the consolidator immediately after confirming a pipeline row.
 *
 * Atomically reads next_payload and, if present, resets the same row back to
 * 'pending' so the coalesced save can be processed next.
 *
 * Returns true if there was a coalesced save pending (consolidator should
 * call the appropriate handler for this step right away).
 * Returns false if next_payload was NULL (nothing to do).
 */
export async function claimAndResetForResubmit(
  rowId: string
): Promise<boolean> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
         SET status        = 'pending',
             next_payload  = NULL,
             bridge_op_id  = NULL,
             qb_result     = NULL,
             error         = NULL,
             submitted_at  = NULL,
             confirmed_at  = NULL,
             failed_at     = NULL,
             updated_at    = NOW(),
             retry_count   = 0
         WHERE id          = $1
           AND next_payload IS NOT NULL
         RETURNING id`,
    [rowId]
  );
  return rows.length > 0;
}

/**
 * Find the most recent in-flight pipeline row for a given document.
 * Returns the row if one exists with status 'processing'/'submitted', or 'pending' with a
 * bridge_op_id (already dispatched). Pre-flight 'pending' rows without a
 * bridge_op_id are excluded — they haven't been sent to the bridge yet and
 * waiting on them would deadlock (the caller IS the one that will submit them).
 */
export async function findLatestInFlightRow(
  orderId: string,
  steps: string[]
): Promise<{
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, status, created_at, updated_at
         FROM qb_order_pipeline
         WHERE order_id = $1 AND step = ANY($2)
           AND (status IN ('processing', 'submitted') OR (status = 'pending' AND bridge_op_id IS NOT NULL))
         ORDER BY created_at DESC
         LIMIT 1`,
    [orderId, steps]
  );
  return rows[0] ?? null;
}
