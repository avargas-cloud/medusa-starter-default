import { getDbPool } from "../../api/utils/db-pool";

/**
 * Which QuickBooks customer (ListID) must a document of this order be issued
 * under?
 *
 * Decision B1 (2026-08-06): the LIVE customer always wins. The cached
 * `order.metadata.qb_list_id` exists only as a fallback for orders whose
 * customer has no ListID yet, and it is re-stamped whenever it disagrees with
 * the live customer — a stale cache is exactly how order 2945 invoiced JEGOLL
 * LLC under "Any Projects" (QB 3120 on the payment apply).
 *
 * The re-stamp is a single-key jsonb merge (`||`) so no other metadata key is
 * touched, and it is best-effort: resolution still returns the live value even
 * if the write fails.
 */

interface QbHandlerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ResolveOrderQbCustomerOpts {
  orderId: string;
  /**
   * `order.metadata.qb_list_id` when the caller already fetched the order.
   * `null` means "known absent"; omit the field to have it fetched here.
   */
  cachedListId?: string | null;
  /**
   * `customer.metadata.qb_list_id` when the caller already fetched the
   * customer. `null` means "known absent"; omit the field to have it fetched.
   */
  liveListId?: string | null;
  logger?: QbHandlerLogger;
}

export async function resolveOrderQbCustomer(
  opts: ResolveOrderQbCustomerOpts
): Promise<string | undefined> {
  let { cachedListId, liveListId } = opts;
  const pool = getDbPool();

  if (liveListId === undefined || cachedListId === undefined) {
    const { rows } = await pool.query(
      `SELECT o.metadata->>'qb_list_id' AS cached,
              c.metadata->>'qb_list_id' AS live
         FROM "order" o
         LEFT JOIN customer c ON c.id = o.customer_id
        WHERE o.id = $1`,
      [opts.orderId]
    );
    const row = rows[0] as { cached: string | null; live: string | null } | undefined;
    if (cachedListId === undefined) cachedListId = row?.cached ?? null;
    if (liveListId === undefined) liveListId = row?.live ?? null;
  }

  if (liveListId) {
    if (cachedListId !== liveListId) {
      const why = cachedListId
        ? `stale cache ${cachedListId}`
        : "no cached value yet";
      opts.logger?.warn(
        `[QB] order ${opts.orderId}: qb_list_id ${why} → live customer ${liveListId}; re-stamping order metadata`
      );
      try {
        // Provenance rides along: qb_list_id_customer_id records WHOSE ListID
        // the cache holds, so a later fallback can refuse a previous owner's.
        await pool.query(
          `UPDATE "order"
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('qb_list_id', $1::text,
                                        'qb_list_id_customer_id', customer_id)
            WHERE id = $2`,
          [liveListId, opts.orderId]
        );
      } catch (err) {
        opts.logger?.warn(
          `[QB] order ${opts.orderId}: could not re-stamp qb_list_id: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return liveListId;
  }

  if (!cachedListId) return undefined;

  // Fallback to the cache ONLY if it does not belong to a previous owner.
  // Scenario this refuses (Codex review 2026-08-06, CRITICAL #1): order
  // transferred to a customer that has not synced to QB yet — the cache still
  // holds the OLD customer's ListID, and using it would issue the document
  // under the previous owner. Legacy rows without provenance keep the old
  // behavior (their cache is the only source there is).
  try {
    const { rows } = await pool.query(
      `SELECT customer_id,
              metadata->>'qb_list_id_customer_id' AS prov
         FROM "order"
        WHERE id = $1`,
      [opts.orderId]
    );
    const row = rows[0] as
      | { customer_id: string | null; prov: string | null }
      | undefined;
    if (row?.prov && row.customer_id && row.prov !== row.customer_id) {
      opts.logger?.warn(
        `[QB] order ${opts.orderId}: cached qb_list_id belongs to previous customer ${row.prov} (current ${row.customer_id}) — refusing fallback`
      );
      return undefined;
    }
  } catch (err) {
    opts.logger?.warn(
      `[QB] order ${opts.orderId}: could not verify qb_list_id provenance: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return cachedListId;
}
