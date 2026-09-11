import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { updateSalesOrderInQb } from "../client/sales-orders";
import {
  resolveProductTaxableMap,
  resolveLineTaxableMap,
  getEffectiveOrderDiscount,
  type MedusaOrderForQb,
} from "../order-flow-core";
import { getFloat } from "./utils";
import { buildSalesOrderModQbItems } from "../build-sales-order-mod-items";
import { getQbConfig } from "../qb-config";
import { parseSalesRepInitials } from "../parse-sales-rep";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";
import { getSoTxnId, getSoRef } from "../qb-metadata-types";
import {
  claimSalesMutationRow,
  enqueueSalesMutation,
  failPipelineRow,
  findConfirmedAddTxnId,
  findLatestInFlightRow,
  pollUntilQbConfirmed,
  submitPipelineRowById,
} from "../qb-pipeline";
import {
  gateModDispatch,
  MOD_DISPATCH_SERIALIZER_WAIT_MS,
} from "../pipeline/mod-dispatch-gate";
import { withQbSerialized } from "../qb-serializer";

/**
 * Handle Sales Order MOD (update existing QB Sales Order).
 *
 * Append-only lane (2026-08-06) — mirrors handle-draft-order-updated.ts: every
 * edit gets its OWN `sales_order_mod` pipeline row via enqueueSalesMutation;
 * the ADD's `sales_order` row keeps its confirm forever. All status
 * transitions thread the row's UUID (claim → submit → confirm/fail).
 *
 * Sequential-save behaviour:
 *   - Edits while a previous edit is still queued coalesce at enqueue time.
 *   - Edits while the CREATE is still in flight park as a 'waiting' row behind
 *     the ADD (depends_on); the wake pass promotes it after the confirm and
 *     the dispatcher resolves the fresh TxnID from metadata.
 *   - withQbSerialized still guarantees sequential bridge calls per order
 *     across sales_order + sales_order_mod.
 *
 * Consolidator path (isCron + pipelineRowId) — 2026-09-11: the dispatcher
 *   NEVER waits for a confirmation. Before touching the bridge the row passes
 *   `gateModDispatch`: with an older operation in flight on the same document
 *   the row is deferred (pending + next_retry_at) instead of blocking the tick,
 *   and after the submit the callback returns — the submitted-poller confirms
 *   within a minute. Waiting here used to hold the worker's only job slot for
 *   5 minutes per edit (see pipeline/mod-dispatch-gate.ts).
 *
 * Returns:
 *   - "coalesced" — absorbed by a queued row or parked behind the in-flight ADD.
 *   - "deferred"  — consolidator path only: an older operation on the same
 *                   document is in flight; the row went back to pending with
 *                   next_retry_at and a later tick re-dispatches it.
 *   - "scheduled" — serialized dispatch scheduled (or ran, when awaited).
 *   - "skipped"   — order has no qb_sales_order.txn_id and no in-flight ADD.
 */
export async function handleOrderUpdated(
  orderId: string,
  container: any,
  logger: any,
  opts?: {
    isCron?: boolean;
    awaitSerialized?: boolean;
    pipelineRowId?: string;
    /**
     * Pipeline row the CALLER already claimed (the consolidator's legacy
     * 'sales_order' vehicle row, or the sales_order_mod row itself). Excluded
     * from every in-flight lookup — a claimed row is 'processing' and would be
     * detected as its own in-flight ADD, parking a phantom mod behind itself.
     */
    excludeRowId?: string;
  }
): Promise<"coalesced" | "deferred" | "scheduled" | "skipped"> {
  const LOG_PREFIX = "[QB-ORDER-UPDATED]";

  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  let order: any;
  try {
    const { data: results } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "metadata",
        "items.*",
        "items.variant.*",
        "items.variant.metadata",
        "customer.*",
        "customer.metadata",
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });
    order = results?.[0];
  } catch (fetchErr: any) {
    logger.error(`${LOG_PREFIX} ❌ Failed to fetch order: ${fetchErr.message}`);
    return "skipped";
  }

  if (!order) {
    logger.warn(`${LOG_PREFIX} Order ${orderId} not found`);
    return "skipped";
  }

  let resolvedTxnId = getSoTxnId(order.metadata) ?? null;
  const qbRef = getSoRef(order.metadata) ?? null;
  const medusaRef = order.display_id ? `S${order.display_id}` : null;

  if (!resolvedTxnId) {
    if (opts?.pipelineRowId) {
      // Wake-vs-metadata race: the parent ADD row confirms (with its TxnID)
      // before the order-metadata write lands, and the wake pass runs
      // independently — resolve from the confirmed row before giving up.
      resolvedTxnId = await findConfirmedAddTxnId(orderId, ["sales_order"]);
      if (!resolvedTxnId) {
        // No TxnID anywhere — nothing to modify. The caller fails the row.
        return "skipped";
      }
    } else {
    const inFlightAdd = await findLatestInFlightRow(orderId, ["sales_order"], {
      excludeRowId: opts?.excludeRowId ?? null,
    });
    if (inFlightAdd) {
      const parked = await enqueueSalesMutation({
        step: "sales_order_mod",
        orderId,
        qbTxnId: null,
        payload: {},
        medusaRefNumber: medusaRef,
        dependsOn: inFlightAdd.id,
        status: "waiting",
      });
      logger.info(
        `${LOG_PREFIX} ⏸ SO CREATE in-flight for ${orderId} — edit parked as waiting sales_order_mod row ${parked.rowId}`
      );
      return "coalesced";
    }
    logger.info(
      `${LOG_PREFIX} No qb_sales_order.txn_id on ${orderId} — cannot MOD (use CREATE)`
    );
    return "skipped";
    }
  }
  const qbTxnId = resolvedTxnId;

  // Own row for this edit (insert, or coalesce into the un-dispatched tail).
  let rowId = opts?.pipelineRowId ?? null;
  if (!rowId) {
    const enqueued = await enqueueSalesMutation({
      step: "sales_order_mod",
      orderId,
      qbTxnId,
      payload: {},
      medusaRefNumber: medusaRef,
      qbRefNumber: qbRef,
    });
    rowId = enqueued.rowId;
    // Reflect "pending" on the order metadata so the UI badge updates.
    try {
      await getDbPool().query(
        `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ qb_sync_status: "pending" }), orderId]
      );
    } catch {
      /* best-effort */
    }
  }
  const dispatchRowId = rowId;

  // Consolidator path: the dispatch pass already claimed this row. If an older
  // operation on this Sales Order is still in flight, step aside NOW — never
  // wait inside the tick for a confirmation another cron has to write.
  if (opts?.isCron && opts?.pipelineRowId) {
    const gate = await gateModDispatch({
      rowId: dispatchRowId,
      orderId,
      steps: ["sales_order", "sales_order_mod"],
      step: "sales_order_mod",
      logger,
      logPrefix: LOG_PREFIX,
    });
    if (gate === "deferred") return "deferred";
  }

  const runCallback = async (): Promise<void> => {
    if (!opts?.pipelineRowId) {
      const claimed = await claimSalesMutationRow(dispatchRowId);
      if (!claimed) {
        logger.info(
          `${LOG_PREFIX} sales_order_mod ${dispatchRowId} no longer claimable — another dispatcher owns it`
        );
        return;
      }
    }

    // Fetch freshest order state for MOD payload.
    const {
      data: [fullOrder],
    } = await query.graph({
      entity: "order",
      fields: [
        "*",
        "items.*",
        // getEffectiveOrderDiscount reads the per-line adjustments FIRST (an
        // aggregate discount_total cannot express per-line rounding). Without
        // this field it sees none and the MOD would strip the discount pair.
        "items.adjustments.*",
        "items.variant.*",
        "items.variant.metadata",
        "customer.*",
        "customer.metadata",
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });
    if (!fullOrder) {
      logger.warn(`${LOG_PREFIX} Order ${orderId} vanished before MOD`);
      await failPipelineRow(dispatchRowId, "Order vanished before MOD");
      return;
    }

    // Freshest TxnID inside the lock — the consolidator may have persisted a
    // newer one after a prior CREATE confirmed.
    const freshTxnId = getSoTxnId(fullOrder.metadata) ?? qbTxnId;

    const typedOrder = fullOrder as unknown as MedusaOrderForQb;
    const pgConn = container.resolve("__pg_connection__");
    const productTaxableMap = await resolveProductTaxableMap(
      pgConn,
      typedOrder.items || []
    );
    const lineTaxableMap = await resolveLineTaxableMap(
      pgConn,
      typedOrder.items || []
    );
    // A MOD is a full snapshot: a line this payload omits is DELETED from the
    // Sales Order. buildSalesOrderModQbItems adds the freight line the CREATE
    // path already emits — see its doc comment for what stays out and why.
    const qbConfig = await getQbConfig();
    const qbItems = buildSalesOrderModQbItems({
      items: typedOrder.items || [],
      metadata: typedOrder.metadata,
      shippingMethods: (fullOrder as any).shipping_methods || [],
      shippingItemId: qbConfig.shippingItemId,
      productTaxableMap,
      lineTaxableMap,
      orderDiscountTotal: getEffectiveOrderDiscount(fullOrder),
      orderSubtotal: getFloat((fullOrder as any).subtotal),
    });
    const salesRep = parseSalesRepInitials(fullOrder.metadata?.sales_rep);

    // Cases 2-4 (2026-08-06): a customer change on a pos-order must reach the
    // QB Sales Order. Every MOD re-asserts CustomerRef with the LIVE customer.
    const qbCustomerListId = await resolveOrderQbCustomer({
      orderId,
      cachedListId:
        (fullOrder.metadata?.qb_list_id as string | undefined) ?? null,
      liveListId:
        (fullOrder.customer?.metadata?.qb_list_id as string | undefined) ??
        null,
      logger,
    });

    const markMetadataError = async (): Promise<void> => {
      try {
        await getDbPool().query(
          `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"error"}'::jsonb WHERE id = $1`,
          [orderId]
        );
      } catch {
        /* best-effort */
      }
    };

    try {
      const result = await updateSalesOrderInQb({
        txnId: freshTxnId,
        items: qbItems,
        ...(qbCustomerListId ? { customerId: qbCustomerListId } : {}),
        ...(salesRep ? { salesRep } : {}),
      });

      if (result.success) {
        await submitPipelineRowById(
          dispatchRowId,
          result.data?.operationId || null
        );
        if (opts?.isCron) {
          // Never wait inside a scheduled job: the submitted-poller confirms
          // this row on its next tick, and it can only run once we return.
          logger.info(
            `${LOG_PREFIX} sales_order_mod ${dispatchRowId} submitted op=${result.data?.operationId ?? "?"} — confirmation left to the submitted-poller`
          );
        } else {
          const outcome = await pollUntilQbConfirmed(dispatchRowId);
          if (outcome === "timeout") {
            logger.warn(`${LOG_PREFIX} Poll timed out for rowId=${dispatchRowId}`);
          }
        }
      } else {
        await failPipelineRow(dispatchRowId, result.error ?? "QB SO MOD failed");
        await markMetadataError();
      }
    } catch (err: any) {
      logger.error(`${LOG_PREFIX} Exception during SO MOD: ${err.message}`);
      await failPipelineRow(dispatchRowId, err.message);
      await markMetadataError();
    }
  };

  const serialized = withQbSerialized(
    `sales_order:${orderId}`,
    {
      orderId,
      steps: ["sales_order", "sales_order_mod"],
      // Never wait on a row this call chain already owns: the consolidator's
      // claimed vehicle/mod row (excludeRowId) or our own dispatch row.
      excludeRowId: opts?.excludeRowId ?? dispatchRowId,
    },
    runCallback,
    {
      logger,
      // Cron path: the gate already ruled out an OLDER in-flight operation, so
      // anything the serializer still sees is a younger sibling about to defer
      // itself. Never sit in a scheduled job for the default 5 minutes.
      ...(opts?.isCron ? { maxWaitMs: MOD_DISPATCH_SERIALIZER_WAIT_MS } : {}),
    }
  );

  if (opts?.awaitSerialized) {
    await serialized;
  } else {
    serialized.catch((err: any) =>
      logger.error(`${LOG_PREFIX} Serialized callback failed: ${err.message}`)
    );
  }

  return "scheduled";
}
