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

const SUCCESS_STATUSES = new Set(["confirmed", "fixed"]);

/**
 * Appends one immutable operation to a PO-scoped QuickBooks dependency chain.
 *
 * `qb_purchase_dependency_chain` is the serialization point. Its UPSERT locks
 * one row per PO, returns the previous tail, and advances the tail in the same
 * statement that inserts the qb_order_pipeline row. Concurrent enqueues cannot
 * become sibling operations accidentally.
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
