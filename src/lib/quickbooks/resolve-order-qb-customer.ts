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
        await pool.query(
          `UPDATE "order"
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
            WHERE id = $2`,
          [JSON.stringify({ qb_list_id: liveListId }), opts.orderId]
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

  return cachedListId ?? undefined;
}
