import { getDbPool } from "../../../api/utils/db-pool";
import type { PipelineStep } from "./types";

/**
 * Append-only lane for SALES document mutations (2026-08-06).
 *
 * A MOD never recycles the ADD's pipeline row: each edit inserts its own row so
 * the pipeline stays a faithful history of what was sent to QuickBooks and when.
 * The ADD row keeps its confirm (confirmed_at, bridge_op_id, qb_result) forever.
 * writePipelineRow keeps guarding the non-idempotent ADD steps untouched — no
 * MOD goes through it anymore.
 *
 * Coalescing mirrors the Purchase lane (qb-purchase-dependency-chain, shipped
 * 2026-08-04): an edit made while a PREVIOUS edit of the same document + step is
 * still queued (pending/waiting) or rejected (failed) folds into that row —
 * three saves in a minute must not dispatch three Mods, and QB would only see
 * the last state anyway. A row the dispatcher already claimed ('processing') or
 * sent ('submitted') is NEVER touched: the successor inserts a fresh row. The
 * payload is a FULL snapshot (it replaces on coalesce — partial payloads are
 * what mergePayload existed for under the old single-row model, and they don't
 * carry over). Absorbed edits stay visible in payload.coalesced_edits.
 */

/** Steps that go through the append-only sales-mutation lane. */
export const SALES_MOD_STEPS = [
  "estimate_mod",
  "sales_order_mod",
  "invoice_update",
  "sales_receipt_update",
  "credit_memo_mod",
  "payment_method_change",
  "payment_txndate_change",
] as const;

export type SalesModStep = (typeof SALES_MOD_STEPS)[number];

export function isSalesModStep(step: string): step is SalesModStep {
  return (SALES_MOD_STEPS as readonly string[]).includes(step);
}

/** Maps a CREATE step to its mod-lane step (for writePipelineRow redirects). */
export const CREATE_STEP_TO_MOD_STEP: Partial<Record<PipelineStep, SalesModStep>> = {
  estimate: "estimate_mod",
  sales_order: "sales_order_mod",
  invoice: "invoice_update",
  sales_receipt: "sales_receipt_update",
};

/**
 * Statuses a queued mutation can be coalesced in. 'failed' is deliberate: a
 * rejected Mod changed nothing in QB, so folding the next edit into it IS the
 * repair flow (same call as Purchase). 'processing'/'submitted' are never
 * eligible — that operation is already on its way to the bridge.
 */
const COALESCIBLE_STATUSES = ["pending", "waiting", "failed"] as const;

export interface EnqueueSalesMutationInput {
  step: SalesModStep;
  orderId?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  /**
   * The QB document this MOD targets. Mandatory before a row may sit
   * 'pending' — the one exception is a 'waiting' row parked behind the
   * in-flight ADD of its own document (dependsOn set): the TxnID does not
   * exist yet and the dispatcher resolves it fresh from metadata at wake.
   */
  qbTxnId: string | null;
  /**
   * FULL snapshot of what QB should end up with — replaces on coalesce. An
   * EMPTY payload means "this caller carries no document state" (header-only
   * bookkeeping rows around an inline dispatch, e.g. update-tax): it never
   * replaces a queued snapshot — coalescing keeps the previous payload intact.
   */
  payload?: Record<string, unknown> | null;
  /**
   * Shallow-merge this payload over the queued tail's snapshot instead of
   * replacing it. For narrow callers that only know a couple of header fields
   * (patch-meta's tax/rep-only credit_memo_mod) — a partial payload must never
   * drop keys a broader edit staged (CM-1087 class of data loss).
   */
  mergePayload?: boolean;
  medusaRefNumber?: string | null;
  qbRefNumber?: string | null;
  dependsOn?: string | null;
  /** 'waiting' parks the row behind depends_on; default 'pending'. */
  status?: "pending" | "waiting";
}

export interface EnqueueSalesMutationResult {
  rowId: string;
  mode: "inserted" | "coalesced";
}

/**
 * Builds the payload that lands on a coalesced row. Pure — unit-tested.
 *
 * - The NEW snapshot wins wholesale (full-snapshot contract).
 * - `qbLineOrder` is recovery metadata stamped by the 3290 line-order heal on
 *   the ROW, not part of any edit's snapshot: if the previous payload carries
 *   it and the new one doesn't, it survives the replace (dropping it would
 *   silently disarm the heal for that document).
 * - `coalesced_edits` accumulates one entry per absorbed edit so collapsing
 *   never hides that multiple saves happened.
 */
export function buildCoalescedSnapshot(
  previousPayload: Record<string, unknown> | null,
  nextPayload: Record<string, unknown> | null,
  coalescedAtIso: string,
  mergePayload = false
): Record<string, unknown> {
  const prev = previousPayload ?? {};
  const next = nextPayload ?? {};
  const nextHasState =
    Object.keys(next).filter((k) => k !== "coalesced_edits").length > 0;
  // An empty incoming snapshot must never erase a queued one — the caller
  // simply carries no document state (header-only bookkeeping). A mergePayload
  // caller layers its keys OVER the queued snapshot instead of replacing it.
  const merged: Record<string, unknown> = !nextHasState
    ? { ...prev }
    : mergePayload
      ? { ...prev, ...next }
      : { ...next };
  if (prev.qbLineOrder !== undefined && merged.qbLineOrder === undefined) {
    merged.qbLineOrder = prev.qbLineOrder;
  }
  const prevEdits = Array.isArray(prev.coalesced_edits)
    ? (prev.coalesced_edits as unknown[])
    : [];
  merged.coalesced_edits = [...prevEdits, { at: coalescedAtIso }];
  return merged;
}

/**
 * Enqueues a sales-document mutation as its own pipeline row (append-only),
 * coalescing into the still-queued tail of the same (document, step) when one
 * exists. Returns the row's UUID — callers MUST thread it through submit /
 * confirm / fail transitions (confirmPipelineRow / failPipelineRow /
 * submitPipelineRowById), never transition by (document, step) again.
 */
export async function enqueueSalesMutation(
  input: EnqueueSalesMutationInput
): Promise<EnqueueSalesMutationResult> {
  if (!isSalesModStep(input.step)) {
    throw new Error(
      `enqueueSalesMutation: step "${input.step}" is not a sales mutation step`
    );
  }
  // payment_txndate_change resolves its target document LIVE at dispatch (an
  // SR-embedded payment has no ReceivePayment TxnID to carry) — see the
  // consolidator's case. Every other step must know its target up front.
  const resolvesTargetAtDispatch = input.step === "payment_txndate_change";
  const waitingBehindAdd = input.status === "waiting" && !!input.dependsOn;
  if (!input.qbTxnId && !waitingBehindAdd && !resolvesTargetAtDispatch) {
    throw new Error(
      `enqueueSalesMutation: step "${input.step}" requires qbTxnId (the QB doc to modify) — ` +
        `only a 'waiting' row behind its document's in-flight ADD (dependsOn) may omit it`
    );
  }
  const docKey = input.referenceId ?? input.orderId;
  if (!docKey) {
    throw new Error(
      `enqueueSalesMutation: step "${input.step}" requires referenceId or orderId`
    );
  }
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One enqueue at a time per (step, document): the lock covers the whole
    // read-tail → coalesce/insert decision, so two concurrent saves can't both
    // conclude "no tail" and insert twins.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('qb-sales-mod:' || $1 || ':' || $2))`,
      [input.step, docKey]
    );

    const { rows: tail } = await client.query(
      `SELECT id, status, payload
         FROM qb_order_pipeline
        WHERE step = $1
          AND (
            ($2::text IS NOT NULL AND reference_id = $2::text)
            OR ($2::text IS NULL AND $3::text IS NOT NULL AND order_id = $3::text)
          )
          AND status = ANY($4::text[])
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [
        input.step,
        input.referenceId ?? null,
        input.orderId ?? null,
        [...COALESCIBLE_STATUSES],
      ]
    );

    if (tail.length > 0) {
      const row = tail[0] as {
        id: string;
        status: string;
        payload: Record<string, unknown> | null;
      };
      const merged = buildCoalescedSnapshot(
        row.payload,
        input.payload ?? null,
        new Date().toISOString(),
        input.mergePayload ?? false
      );
      // A 'failed' tail reactivates to 'pending' (the rejected Mod changed
      // nothing in QB; its error stays as the record of the attempt). A
      // 'waiting' tail keeps waiting — its dependency still gates it.
      await client.query(
        `UPDATE qb_order_pipeline
            SET payload           = $2::jsonb,
                status            = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
                next_retry_at     = NULL,
                failed_at         = NULL,
                qb_txn_id         = COALESCE($3, qb_txn_id),
                medusa_ref_number = COALESCE($4, medusa_ref_number),
                qb_ref_number     = COALESCE($5, qb_ref_number),
                depends_on        = COALESCE($6, depends_on),
                updated_at        = NOW()
          WHERE id = $1`,
        [
          row.id,
          JSON.stringify(merged),
          input.qbTxnId,
          input.medusaRefNumber ?? null,
          input.qbRefNumber ?? null,
          input.dependsOn ?? null,
        ]
      );
      await client.query("COMMIT");
      return { rowId: row.id, mode: "coalesced" };
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO qb_order_pipeline
              (order_id, reference_id, reference_type, step, status, depends_on,
               qb_txn_id, qb_ref_number, medusa_ref_number, payload, retry_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
       RETURNING id`,
      [
        input.orderId ?? null,
        input.referenceId ?? null,
        input.referenceType ?? null,
        input.step,
        input.status ?? "pending",
        input.dependsOn ?? null,
        input.qbTxnId,
        input.qbRefNumber ?? null,
        input.medusaRefNumber ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
      ]
    );
    await client.query("COMMIT");
    return { rowId: inserted[0].id as string, mode: "inserted" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically claims a queued mutation row for inline dispatch (route path).
 * Returns false when the row is no longer claimable — the consolidator's
 * dispatch pass got there first (it claims 'processing' the same way), the row
 * coalesced away, or it already reached a terminal state. The caller MUST NOT
 * dispatch on false: whoever holds the claim will.
 */
export async function claimSalesMutationRow(rowId: string): Promise<boolean> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'processing', updated_at = NOW(), error = NULL
      WHERE id = $1 AND status IN ('pending', 'waiting')
      RETURNING id`,
    [rowId]
  );
  return rows.length > 0;
}

/**
 * Resets a mutation row to 'pending' by row UUID — the append-only lane's
 * retry primitive (e.g. a 3200 stale-EditSequence retry about to re-dispatch).
 * Never resurrects a confirmed row.
 */
export async function reactivateSalesMutationRow(rowId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'pending',
            bridge_op_id = NULL,
            error = NULL,
            failed_at = NULL,
            submitted_at = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status <> 'confirmed'`,
    [rowId]
  );
}

/**
 * Marks a mutation row as submitted to the bridge, by row UUID. The by-id
 * counterpart of confirmPipelineRow/failPipelineRow for the dispatch moment —
 * callers on the append-only lane never transition by (document, step).
 */
export async function submitPipelineRowById(
  rowId: string,
  bridgeOpId: string | null
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status       = 'submitted',
            bridge_op_id = COALESCE($2, bridge_op_id),
            submitted_at = NOW(),
            updated_at   = NOW()
      WHERE id = $1`,
    [rowId, bridgeOpId]
  );
}
