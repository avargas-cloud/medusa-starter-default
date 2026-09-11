/**
 * Mod dispatch gate — decides whether a claimed `*_mod` row goes to the bridge
 * NOW or steps aside behind another in-flight operation on the same document.
 *
 * ── Why this exists (2026-09-11) ─────────────────────────────────────────────
 * The dispatch tick used to call the mod handler, which then awaited
 * `pollUntilQbConfirmed` for up to 5 minutes. The confirmation it waited for is
 * written by ANOTHER scheduled job (submitted-poller / consolidator Phase A),
 * and Medusa runs scheduled jobs one at a time in the worker — so the tick held
 * the only job slot while waiting for a job that could not run. Measured: every
 * sales_order_mod / estimate_mod confirmed at 301–303 s (26/26 over 7 days) and
 * every per-minute cron in the worker (Meili sync, reconcilers, QB pollers, GL)
 * stood still for those 5 minutes. Two edits in a row froze the worker 10 min.
 *
 * The rule now: the dispatcher NEVER waits for a confirmation. If the document
 * already has an operation in flight, the younger row is DEFERRED (back to
 * `pending` with `next_retry_at`, the same primitive `apply_payment` uses) and a
 * later tick re-dispatches it — after the poller confirmed the older one, which
 * is also the moment the EditSequence cache is fresh, so the mod skips the
 * query round-trip.
 *
 * Tie-break: two rows claimed in the same tick both see each other as
 * 'processing'. Without an order they would both defer, forever. The OLDEST
 * in-flight row on the document goes first (created_at, then id); everyone
 * younger defers. `decideModDispatch` is pure so the ordering is unit-tested
 * without a database; `gateModDispatch` is the IO wrapper the handlers call.
 */
import { getDbPool } from "../../../api/utils/db-pool";
import { deferPipelineRow } from "./row-mutations";

export const MOD_DISPATCH_DEFER_SECONDS = 60;

/**
 * Cap for `withQbSerialized`'s in-flight wait on the consolidator path. The
 * gate already guaranteed no OLDER operation is in flight, so anything the
 * serializer still finds is a YOUNGER sibling claimed in the same tick that is
 * about to defer itself — the only race left is a few milliseconds between its
 * `deferPipelineRow` and our in-flight SELECT. Waiting the serializer's default
 * 5 minutes for a row that will never confirm (it went back to `pending`) is
 * exactly the freeze this module removes, so the cron path waits 5 s at most
 * and then proceeds, which is correct by construction.
 */
export const MOD_DISPATCH_SERIALIZER_WAIT_MS = 5_000;

export type InFlightSibling = {
  id: string;
  status: string;
  created_at: string | Date | null;
};

export type ModDispatchDecision =
  | { action: "dispatch"; reason: string }
  | { action: "defer"; behindRowId: string; reason: string };

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure decision. `inFlight` is the OLDEST in-flight sibling on the document
 * (excluding the row itself), or null when the document is quiescent.
 */
export function decideModDispatch(input: {
  ownRowId: string;
  ownCreatedAt: string | Date | null;
  inFlight: InFlightSibling | null;
}): ModDispatchDecision {
  const { ownRowId, ownCreatedAt, inFlight } = input;
  if (!inFlight || inFlight.id === ownRowId) {
    return {
      action: "dispatch",
      reason: "no other in-flight operation on this document",
    };
  }
  const ownTs = toMs(ownCreatedAt);
  const otherTs = toMs(inFlight.created_at);
  if (ownTs === null || otherTs === null) {
    // Unknown ordering: yield. A deferral costs one tick; a wrong dispatch
    // sends a MOD with a stale EditSequence (QB 3200) and burns a retry.
    return {
      action: "defer",
      behindRowId: inFlight.id,
      reason: `created_at unknown — yielding to ${inFlight.status} row ${inFlight.id}`,
    };
  }
  const otherIsOlder =
    otherTs < ownTs || (otherTs === ownTs && inFlight.id < ownRowId);
  if (otherIsOlder) {
    return {
      action: "defer",
      behindRowId: inFlight.id,
      reason: `older ${inFlight.status} row ${inFlight.id} on the same document`,
    };
  }
  return {
    action: "dispatch",
    reason: `in-flight row ${inFlight.id} is younger — this row goes first`,
  };
}

/**
 * Oldest in-flight sibling on the document, excluding the caller's own row.
 * Same liveness predicate as `findLatestInFlightRow` (in-flight.ts), but
 * ordered ASC: the gate must compare against the row that will go first, not
 * against the newest one.
 */
export async function findOldestInFlightSibling(
  orderId: string,
  steps: string[],
  excludeRowId: string
): Promise<InFlightSibling | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, status, created_at
       FROM qb_order_pipeline
      WHERE order_id = $1
        AND step = ANY($2)
        AND id <> $3
        AND (
          status IN ('processing', 'submitted')
          OR (status = 'pending' AND bridge_op_id IS NOT NULL)
        )
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [orderId, steps, excludeRowId]
  );
  return (rows[0] as InFlightSibling | undefined) ?? null;
}

/**
 * IO wrapper for the consolidator path: the row is already claimed
 * 'processing' by the dispatch pass. Returns "dispatch" (go to the bridge) or
 * "deferred" (row is back to 'pending' with next_retry_at; caller must stop).
 */
export async function gateModDispatch(input: {
  rowId: string;
  orderId: string;
  steps: string[];
  step: string;
  logger: { info: (msg: string) => void };
  logPrefix: string;
}): Promise<"dispatch" | "deferred"> {
  const { rowId, orderId, steps, step, logger, logPrefix } = input;
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT created_at FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const ownCreatedAt =
    (rows[0]?.created_at as string | Date | null | undefined) ?? null;
  const inFlight = await findOldestInFlightSibling(orderId, steps, rowId);
  const decision = decideModDispatch({ ownRowId: rowId, ownCreatedAt, inFlight });
  if (decision.action === "dispatch") return "dispatch";

  const reason = `${step}: deferred ${MOD_DISPATCH_DEFER_SECONDS}s — ${decision.reason}`;
  await deferPipelineRow(rowId, reason, MOD_DISPATCH_DEFER_SECONDS);
  logger.info(
    `${logPrefix} ⏸ ${step} ${rowId} deferred behind ${decision.behindRowId} (${MOD_DISPATCH_DEFER_SECONDS}s) — the dispatcher never waits on a confirmation`
  );
  return "deferred";
}
