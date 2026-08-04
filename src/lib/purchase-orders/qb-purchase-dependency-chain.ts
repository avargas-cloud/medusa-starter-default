import { createHash, randomUUID } from "crypto";

export type PurchaseQbStep =
  | "purchase_order_mod"
  | "item_receipt_add"
  | "item_receipt_mod"
  | "vendor_bill_add"
  | "vendor_bill_mod"
  | "vendor_bill_rebuild_preflight"
  | "vendor_bill_rebuild_delete";

export interface PurchaseDependencyKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  transaction?: <T>(
    handler: (trx: PurchaseDependencyKnex) => Promise<T>
  ) => Promise<T>;
}

export interface EnqueuePurchaseQbOperationInput {
  purchaseOrderId: string;
  referenceId: string;
  referenceType: "purchase_order" | "item_receipt" | "vendor_bill";
  step: PurchaseQbStep;
  payload: Record<string, unknown>;
  qbTxnId?: string | null;
  operationKey: string;
}

export interface EnqueuedPurchaseQbOperation {
  id: string;
  status: "pending" | "waiting";
  dependsOn: string | null;
  reused: boolean;
}

interface PipelineRow {
  id: string;
  status: string;
  depends_on: string | null;
}

interface TailRow extends PipelineRow {
  step: string;
  reference_id: string | null;
  payload: Record<string, unknown> | null;
}

const SUCCESS_STATUSES = new Set(["confirmed", "fixed"]);

/**
 * Steps whose queued-but-unsent row can absorb a newer edit of the same
 * document instead of stacking another operation behind it.
 *
 * MODs only, and never an ADD: two ADDs are two documents, so collapsing them
 * would silently drop one. `vendor_bill_mod` is excluded too — it has its own
 * lifecycle (rebuild preflight/delete) that this function does not model.
 */
const COALESCIBLE_STEPS = new Set<PurchaseQbStep>([
  "purchase_order_mod",
  "item_receipt_mod",
]);

/**
 * Statuses of an operation that has NOT been handed to QuickBooks and can
 * therefore still be rewritten.
 *
 * `failed` belongs here: a rejected Mod changed nothing in QuickBooks, so
 * re-aiming it at the newer content loses no accounting history — and it is the
 * common repair flow (a mod is rejected, the operator fixes the cause and saves
 * again). Its `error` is deliberately preserved so the rejected attempt stays
 * readable. `processing` and `submitted` are in flight and are never touched:
 * their outcome is already on its way and has to be observed, not overwritten.
 */
const COALESCIBLE_STATUSES = new Set(["pending", "waiting", "failed"]);

/**
 * Appends one immutable operation to a PO-scoped QuickBooks dependency chain.
 *
 * `qb_purchase_dependency_chain` is the serialization point. Its UPSERT locks
 * one row per PO, returns the previous tail, and advances the tail in the same
 * statement that inserts the qb_order_pipeline row. Concurrent enqueues cannot
 * become sibling operations accidentally.
 *
 * "Appends one" is the usual case, not the only one: a MOD whose document
 * already has an unsent MOD at the tail REWRITES that row rather than queueing a
 * second trip to QuickBooks — see `coalesceIntoTail`. The returned id is then
 * the existing row's, with `reused: true`.
 */
export async function enqueuePurchaseQbOperation(
  db: PurchaseDependencyKnex,
  input: EnqueuePurchaseQbOperationInput
): Promise<EnqueuedPurchaseQbOperation> {
  const existing = await findByOperationKey(db, input.operationKey);
  if (existing) return toResult(existing, true);
  if (!db.transaction) {
    throw new Error(
      "QuickBooks purchase dependency enqueue requires a database transaction"
    );
  }

  return db.transaction(async (trx) => {
    await trx.raw(
      `INSERT INTO qb_purchase_dependency_chain
         (purchase_order_id, tail_pipeline_id,
          previous_tail_pipeline_id, updated_at)
       VALUES (?, NULL, NULL, NOW())
       ON CONFLICT (purchase_order_id) DO NOTHING`,
      [input.purchaseOrderId]
    );
    const chainResult = await trx.raw(
      `SELECT tail_pipeline_id
         FROM qb_purchase_dependency_chain
        WHERE purchase_order_id = ?
        FOR UPDATE`,
      [input.purchaseOrderId]
    );
    const tailId =
      (chainResult.rows[0] as { tail_pipeline_id?: string | null } | undefined)
        ?.tail_pipeline_id ?? null;

    // Re-check after acquiring the PO-scoped lock. A concurrent identical
    // enqueue may have committed while this caller was waiting.
    const raced = await findByOperationKey(trx, input.operationKey);
    if (raced) return toResult(raced, true);

    const coalesced = await coalesceIntoTail(trx, tailId, input);
    if (coalesced) return toResult(coalesced, true);

    const id = randomUUID();
    const status = tailId ? "waiting" : "pending";
    const insertedResult = await trx.raw(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, depends_on, status,
          qb_txn_id, payload, purchase_operation_key, created_at, updated_at)
       VALUES (?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?, ?::jsonb, ?, NOW(), NOW())
       RETURNING id, status, depends_on`,
      [
        id,
        input.purchaseOrderId,
        input.referenceId,
        input.referenceType,
        input.step,
        tailId,
        status,
        input.qbTxnId ?? null,
        JSON.stringify(input.payload),
        input.operationKey,
      ]
    );
    const inserted = insertedResult.rows[0] as PipelineRow | undefined;
    if (!inserted) {
      throw new Error(
        `QuickBooks purchase operation '${input.operationKey}' was not inserted`
      );
    }
    await trx.raw(
      `UPDATE qb_purchase_dependency_chain
          SET previous_tail_pipeline_id = tail_pipeline_id,
              tail_pipeline_id = ?::uuid,
              updated_at = NOW()
        WHERE purchase_order_id = ?`,
      [id, input.purchaseOrderId]
    );
    return toResult(inserted, false);
  });
}

/**
 * Folds a newer edit into the queued operation already sitting at the chain's
 * tail, instead of appending another one behind it.
 *
 * WHY: saving a PO three times in a minute used to queue three PurchaseOrderMods
 * for QuickBooks, where only the last one describes reality. The first two are
 * not history — they are undelivered work — so collapsing them loses nothing and
 * keeps the audit trail readable. An operation that DID reach QuickBooks is
 * never collapsed; that distinction is the whole safety argument.
 *
 * ONLY THE TAIL. Coalescing into an older row would move this edit ahead of
 * whatever was queued after it — e.g. an ItemReceipt that was linked against the
 * PO as it stood — so anything but the tail gets a new row, and the chain keeps
 * meaning what it says. Because it is the tail, nothing depends on it yet:
 * no `depends_on` needs repointing and `tail_pipeline_id` stays valid.
 *
 * Concurrency: the caller holds the PO's chain lock, and the SELECT ... FOR
 * UPDATE below takes the row lock. A dispatcher that claimed the row first
 * blocks until this transaction commits and then sees its own status; a
 * dispatcher arriving after blocks until the payload swap is committed. If the
 * row moved out of a coalescible status in between, this returns null and the
 * caller appends a new operation — the fail-safe direction.
 *
 * @returns the rewritten tail row, or null when a new operation is required.
 */
async function coalesceIntoTail(
  trx: PurchaseDependencyKnex,
  tailId: string | null,
  input: EnqueuePurchaseQbOperationInput
): Promise<PipelineRow | null> {
  if (!tailId) return null;
  if (!COALESCIBLE_STEPS.has(input.step)) return null;

  const tailResult = await trx.raw(
    `SELECT id, status, depends_on, step, reference_id, payload
       FROM qb_order_pipeline
      WHERE id = ?::uuid
      FOR UPDATE`,
    [tailId]
  );
  const tail = tailResult.rows[0] as TailRow | undefined;
  if (!tail) return null;
  if (tail.step !== input.step) return null;
  if (String(tail.reference_id ?? "") !== input.referenceId) return null;
  if (!COALESCIBLE_STATUSES.has(String(tail.status))) return null;

  // Full-snapshot payloads: both coalescible steps rebuild the whole document,
  // so REPLACE is required. Merging would leave lines from the superseded edit.
  const previous = Number(
    (tail.payload as { coalesced_edits?: unknown } | null)?.coalesced_edits ?? 0
  );
  const payload = {
    ...input.payload,
    coalesced_edits: previous + 1,
  };

  const updated = await trx.raw(
    `UPDATE qb_order_pipeline
        SET payload = ?::jsonb,
            purchase_operation_key = ?,
            qb_txn_id = COALESCE(?, qb_txn_id),
            status = CASE
              WHEN depends_on IS NULL
                OR EXISTS (
                  SELECT 1 FROM qb_order_pipeline parent
                   WHERE parent.id = qb_order_pipeline.depends_on
                     AND parent.status IN ('confirmed', 'fixed')
                )
              THEN 'pending'
              ELSE 'waiting'
            END,
            bridge_op_id = NULL, submitted_at = NULL, failed_at = NULL,
            next_retry_at = NULL, retry_count = 0,
            updated_at = NOW()
      WHERE id = ?::uuid
        AND status = ?
      RETURNING id, status, depends_on`,
    [
      JSON.stringify(payload),
      input.operationKey,
      input.qbTxnId ?? null,
      tailId,
      tail.status,
    ]
  );
  return (updated.rows[0] as PipelineRow | undefined) ?? null;
}

export function purchaseOperationKey(
  step: PurchaseQbStep,
  referenceId: string,
  payload: Record<string, unknown>
): string {
  const digest = createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex")
    .slice(0, 24);
  return `${step}:${referenceId}:${digest}`;
}

async function findByOperationKey(
  db: PurchaseDependencyKnex,
  operationKey: string
): Promise<PipelineRow | null> {
  const result = await db.raw(
    `SELECT id, status, depends_on
       FROM qb_order_pipeline
      WHERE purchase_operation_key = ?
      LIMIT 1`,
    [operationKey]
  );
  return (result.rows[0] as PipelineRow | undefined) ?? null;
}

function toResult(
  row: PipelineRow,
  reused: boolean
): EnqueuedPurchaseQbOperation {
  return {
    id: String(row.id),
    status: SUCCESS_STATUSES.has(String(row.status))
      ? "pending"
      : row.status === "pending"
        ? "pending"
        : "waiting",
    dependsOn: row.depends_on ? String(row.depends_on) : null,
    reused,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
