import type { Client, PoolClient } from "pg";

export type CompletionQueryClient = Pick<Client | PoolClient, "query">;

export interface EligiblePendingOrder {
  id: string;
  display_id: number;
  document_number: string | null;
  updated_at: Date;
}

export interface EligiblePendingOrderOptions {
  /** Avoid racing an HTTP request that is still settling its final writes. */
  minAgeSeconds?: number;
  limit?: number;
  /** Used by sandbox verification; production sweeps leave this unset. */
  orderIds?: string[];
}

/**
 * Read-only prefilter for genuinely eligible native completions.
 *
 * `maybeCompleteOrder` re-runs every guard under the advisory lock, so this is
 * an optimization and worklist, never the authority that changes status.
 */
export async function listEligiblePendingOrders(
  db: CompletionQueryClient,
  options: EligiblePendingOrderOptions = {}
): Promise<EligiblePendingOrder[]> {
  const minAgeSeconds = Math.max(0, options.minAgeSeconds ?? 0);
  const limit = Math.min(10_000, Math.max(1, options.limit ?? 100));
  const orderIds = options.orderIds?.length ? options.orderIds : null;

  const result = await db.query<EligiblePendingOrder>(
    `SELECT
       o.id,
       o.display_id,
       o.metadata->>'document_number' AS document_number,
       o.updated_at
     FROM "order" o
     WHERE o.status = 'pending'
       AND o.deleted_at IS NULL
       AND o.is_draft_order = false
       AND o.updated_at <= NOW() - ($1::int * INTERVAL '1 second')
       AND ($2::text[] IS NULL OR o.id = ANY($2::text[]))
       -- Every CURRENT-version item is fulfilled. Old versions are historical
       -- and must never block completion.
       AND NOT EXISTS (
         SELECT 1
         FROM order_item oi
         WHERE oi.order_id = o.id
           AND oi.version = o.version
           AND oi.deleted_at IS NULL
           AND oi.fulfilled_quantity < oi.quantity
       )
       -- Invoice ledger and native captures mirror some payments, so take the
       -- greater source; adding them would double-count terminal payments.
       AND GREATEST(
         (SELECT COALESCE(SUM(pi.amount_paid), 0)
            FROM pos_invoice pi
           WHERE pi.order_id = o.id
             AND pi.deleted_at IS NULL
             AND pi.status != 'voided'),
         (SELECT COALESCE(
                   ROUND(SUM(pc.captured_amount - COALESCE(pc.refunded_amount, 0)) * 100),
                   0
                 )
            FROM order_payment_collection opc
            JOIN payment_collection pc
              ON pc.id = opc.payment_collection_id
             AND pc.deleted_at IS NULL
           WHERE opc.order_id = o.id
             AND opc.deleted_at IS NULL)
       ) >= (
         SELECT COALESCE(SUM(pi2.total), 1)
         FROM pos_invoice pi2
         WHERE pi2.order_id = o.id
           AND pi2.deleted_at IS NULL
           AND pi2.status != 'voided'
       ) - 1
       -- A zero-total order is completable only when EVERY active invoice is a
       -- server-stamped paid warranty invoice. This mirrors maybeCompleteOrder.
       AND (
         (SELECT COALESCE(SUM(pi4.total), 0)
            FROM pos_invoice pi4
           WHERE pi4.order_id = o.id
             AND pi4.deleted_at IS NULL
             AND pi4.status != 'voided') > 0
         OR NOT EXISTS (
           SELECT 1
             FROM pos_invoice pi4
            WHERE pi4.order_id = o.id
              AND pi4.deleted_at IS NULL
              AND pi4.status != 'voided'
              AND (
                pi4.total != 0
                OR pi4.status != 'paid'
                OR pi4.metadata->'zero_total_evidence'->>'schema' IS DISTINCT FROM '1'
                OR pi4.metadata->'zero_total_evidence'->>'reason' IS DISTINCT FROM 'warranty'
                OR COALESCE(pi4.metadata->'zero_total_evidence'->>'confirmed_at', '') = ''
                OR COALESCE(pi4.metadata->'zero_total_evidence'->>'confirmed_by', '') = ''
                OR COALESCE(pi4.metadata->'zero_total_evidence'->>'source', '')
                     NOT IN ('pos_confirmation', 'legacy_backfill')
              )
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pos_credit_memo cm
         WHERE cm.order_id = o.id
           AND cm.deleted_at IS NULL
           AND cm.status NOT IN ('completed', 'voided')
       )
       AND EXISTS (
         SELECT 1
         FROM pos_invoice pi3
         WHERE pi3.order_id = o.id
           AND pi3.deleted_at IS NULL
           AND pi3.status != 'voided'
       )
     ORDER BY o.updated_at ASC, o.id ASC
     LIMIT $3`,
    [minAgeSeconds, orderIds, limit]
  );

  return result.rows;
}
