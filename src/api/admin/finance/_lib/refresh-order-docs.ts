import { ContainerRegistrationKeys } from "@medusajs/utils";

import { syncOrders } from "../../../../subscribers/order-meilisearch-sync";

/**
 * Only what this helper actually uses, rather than the full MedusaContainer.
 *
 * It takes a scope instead of the whole request because the order-apply path is
 * a helper that receives only a container — and that path is the deposit case,
 * the one that matters most here. Typing it structurally lets both a route's
 * `req.scope` and that helper's loosely-typed `scope` pass without a cast at the
 * callsite, which would be a cast that hides a real mismatch.
 */
type Scope = { resolve: (key: string) => unknown };

type Logger = { warn: (message: string) => void };

type SqlClient = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Rebuilds the Meili docs of every order a payment touches.
 *
 * Why this exists: `effective_payment` and `is_unpaid` are computed when an
 * order is INDEXED, and until 2026-07-29 no finance route rebuilt the doc after
 * moving money. Collecting the balance of an order left it indexed as
 * "deposited" forever — 960 orders sat in that bucket when only 58 actually owed
 * anything, and #1348/#1350/#1351/#1353 were paid to the cent while the Deposited
 * filter still returned them.
 *
 * Resolution is by PAYMENT rather than by order, so one helper serves all four
 * money-moving routes: apply knows its order directly, but an application void
 * or unlink only knows its application, and a payment void only knows its lock.
 * Every order reachable through this payment's applications gets refreshed.
 *
 * Voided and deleted applications are included on purpose: unlinking a payment
 * has to refresh the order it was just removed from, and that row is voided by
 * the time this runs.
 *
 * Deliberately NOT an `order.updated` emit. That event has other consumers,
 * among them the QuickBooks pipeline, and waking it from a payment flow could
 * enqueue a non-reversible external operation as a side effect of a freshness
 * fix.
 *
 * Never throws: a stale search document must not fail the money operation that
 * already committed. The next order event, or a reindex, heals it.
 */
export async function refreshOrderDocsForPayment(
  scope: Scope,
  paymentId: string
): Promise<void> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger;
  try {
    const pg = scope.resolve("__pg_connection__") as SqlClient;
    const result = await pg.raw(
      `
        SELECT DISTINCT pa.order_id
        FROM payment_application pa
        WHERE pa.payment_id = ?
          AND pa.order_id IS NOT NULL
      `,
      [paymentId]
    );
    const orderIds = (result.rows as Array<{ order_id: string }>)
      .map((row) => row.order_id)
      .filter(Boolean);

    if (orderIds.length === 0) return;
    await syncOrders(orderIds, scope, logger);
  } catch (error) {
    logger.warn(
      `[finance] order doc refresh skipped for payment ${paymentId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
