import { ContainerRegistrationKeys } from "@medusajs/utils";

import { updateEstimateInQb } from "../client/estimates";
import { buildQbItems, resolveProductTaxableMap, type MedusaOrderForQb } from "../order-flow-core";
import { parseSalesRepInitials } from "../parse-sales-rep";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";
import { getEstimateTxnId, getEstimateRef } from "../qb-metadata-types";
import {
  claimSalesMutationRow,
  enqueueSalesMutation,
  failPipelineRow,
  findConfirmedAddTxnId,
  findLatestInFlightRow,
  pollUntilQbConfirmed,
  submitPipelineRowById,
} from "../qb-pipeline";
import { withQbSerialized } from "../qb-serializer";

/**
 * Handle Estimate MOD (update existing QB Estimate).
 *
 * Append-only lane (2026-08-06): every edit gets its OWN `estimate_mod`
 * pipeline row via enqueueSalesMutation — the ADD's `estimate` row keeps its
 * confirm forever. All status transitions thread the row's UUID
 * (claim → submit → confirm/fail); nothing matches by (document, step).
 *
 * Sequential-save behaviour:
 *   - Edits while a PREVIOUS edit is still queued coalesce at enqueue time
 *     (enqueueSalesMutation folds into the un-dispatched tail).
 *   - Edits while the CREATE is still in flight park as a 'waiting' row behind
 *     the ADD row (depends_on); the wake pass promotes it after the confirm and
 *     the consolidator resolves the fresh TxnID from metadata at dispatch.
 *     This replaces the old next_payload/coalesceIfInFlight recycling.
 *   - withQbSerialized still guarantees strictly sequential bridge calls per
 *     order across estimate + estimate_mod.
 *
 * Callable from:
 *   - sync-pos route (user-initiated save)
 *   - consolidator resubmitByStep case "estimate_mod" (passes pipelineRowId of
 *     the row it already claimed 'processing')
 *   - legacy "estimate" rows resubmitted by the consolidator (no pipelineRowId)
 *
 * Returns:
 *   - "coalesced" — the edit was absorbed by a queued row or parked behind the
 *     in-flight ADD; nothing to dispatch now.
 *   - "scheduled" — serialized dispatch was scheduled (or ran, when awaited).
 *   - "skipped"   — draft order has no qb_estimate_txn_id and no in-flight ADD
 *     to wait for (use CREATE path instead).
 */
export async function handleDraftOrderUpdated(
  draftOrderId: string,
  container: any,
  logger: any,
  opts?: {
    isCron?: boolean;
    awaitSerialized?: boolean;
    pipelineRowId?: string;
    /**
     * Pipeline row the CALLER already claimed (the consolidator's legacy
     * 'estimate' vehicle row, or the estimate_mod row itself). Excluded from
     * every in-flight lookup — a claimed row is 'processing' and would be
     * detected as its own in-flight ADD, parking a phantom mod behind itself.
     */
    excludeRowId?: string;
  }
): Promise<"coalesced" | "scheduled" | "skipped"> {
  const LOG_PREFIX = "[QB-DRAFT-ORDER-UPDATED]";

  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  let draftOrder: any;
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
      filters: { id: draftOrderId },
    });
    draftOrder = results?.[0];
  } catch (fetchErr: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch draft order: ${fetchErr.message}`
    );
    return "skipped";
  }

  if (!draftOrder) {
    logger.warn(`${LOG_PREFIX} Draft order ${draftOrderId} not found`);
    return "skipped";
  }

  let resolvedTxnId = getEstimateTxnId(draftOrder.metadata) ?? null;
  const qbRef = getEstimateRef(draftOrder.metadata) ?? null;
  const medusaRef = draftOrder.display_id ? `E${draftOrder.display_id}` : null;

  if (!resolvedTxnId) {
    if (opts?.pipelineRowId) {
      // Wake-vs-metadata race: the parent ADD row confirms (with its TxnID)
      // before the order-metadata write lands, and the wake pass runs
      // independently — resolve from the confirmed row before giving up.
      resolvedTxnId = await findConfirmedAddTxnId(draftOrderId, ["estimate"]);
      if (!resolvedTxnId) {
        // No TxnID anywhere — nothing to modify. The caller fails the row.
        return "skipped";
      }
    } else {
    // No TxnID yet: if the CREATE is still in flight, park this edit behind it
    // instead of losing it. The wake pass promotes it on confirm and the
    // dispatcher resolves the fresh TxnID from metadata.
    const inFlightAdd = await findLatestInFlightRow(draftOrderId, ["estimate"], {
      excludeRowId: opts?.excludeRowId ?? null,
    });
    if (inFlightAdd) {
      const parked = await enqueueSalesMutation({
        step: "estimate_mod",
        orderId: draftOrderId,
        qbTxnId: null,
        payload: {},
        medusaRefNumber: medusaRef,
        dependsOn: inFlightAdd.id,
        status: "waiting",
      });
      logger.info(
        `${LOG_PREFIX} ⏸ Estimate CREATE in-flight for ${draftOrderId} — edit parked as waiting estimate_mod row ${parked.rowId}`
      );
      return "coalesced";
    }
    logger.info(
      `${LOG_PREFIX} No qb_estimate_txn_id on ${draftOrderId} — cannot MOD (use CREATE)`
    );
    return "skipped";
    }
  }
  const qbTxnId = resolvedTxnId;

  // Own row for this edit. The consolidator path arrives with the row already
  // claimed 'processing'; the route path enqueues (insert or coalesce into the
  // queued tail) and claims it before dispatching inline.
  let rowId = opts?.pipelineRowId ?? null;
  if (!rowId) {
    const enqueued = await enqueueSalesMutation({
      step: "estimate_mod",
      orderId: draftOrderId,
      qbTxnId,
      payload: {},
      medusaRefNumber: medusaRef,
      qbRefNumber: qbRef,
    });
    rowId = enqueued.rowId;
  }
  const dispatchRowId = rowId;

  const runCallback = async (): Promise<void> => {
    // Inline path: claim the row so the consolidator's dispatch pass and this
    // route never dispatch the same operation twice. The consolidator path
    // (pipelineRowId) already holds the claim.
    if (!opts?.pipelineRowId) {
      const claimed = await claimSalesMutationRow(dispatchRowId);
      if (!claimed) {
        logger.info(
          `${LOG_PREFIX} estimate_mod ${dispatchRowId} no longer claimable — another dispatcher owns it`
        );
        return;
      }
    }

    // Re-fetch the freshest order state at execution time
    const {
      data: [fullOrder],
    } = await query.graph({
      entity: "order",
      fields: [
        "*",
        "items.*",
        "items.variant.*",
        "items.variant.metadata",
        "customer.*",
        "customer.metadata",
        "shipping_methods.*",
      ],
      filters: { id: draftOrderId },
    });
    if (!fullOrder) {
      logger.warn(`${LOG_PREFIX} Order ${draftOrderId} vanished before MOD`);
      await failPipelineRow(dispatchRowId, "Order vanished before MOD");
      return;
    }

    // Re-read qb_txn_id from the freshly-fetched metadata — the consolidator
    // may have persisted a newer TxnID after a prior CREATE confirmed.
    const freshTxnId = getEstimateTxnId(fullOrder.metadata) ?? qbTxnId;

    const typedOrder = fullOrder as unknown as MedusaOrderForQb;
    const productTaxableMap = await resolveProductTaxableMap(
      container.resolve("__pg_connection__"),
      typedOrder.items || []
    );
    const qbItems = buildQbItems(typedOrder.items || [], typedOrder.metadata, productTaxableMap);
    const memo =
      (fullOrder.metadata?.document_number as string | undefined) ||
      (fullOrder.display_id ? `E${fullOrder.display_id}` : freshTxnId);
    const salesRep = parseSalesRepInitials(fullOrder.metadata?.sales_rep);

    // Case 1 (2026-08-06): a customer change on a pos-estimate must reach the
    // QB Estimate. Every MOD re-asserts CustomerRef with the LIVE customer.
    const qbCustomerListId = await resolveOrderQbCustomer({
      orderId: draftOrderId,
      cachedListId:
        (fullOrder.metadata?.qb_list_id as string | undefined) ?? null,
      liveListId:
        (fullOrder.customer?.metadata?.qb_list_id as string | undefined) ??
        null,
      logger,
    });

    const result = await updateEstimateInQb({
      txnId: freshTxnId,
      items: qbItems,
      memo,
      salesRep,
      ...(qbCustomerListId ? { customerId: qbCustomerListId } : {}),
    });

    if (result.success) {
      await submitPipelineRowById(
        dispatchRowId,
        result.data?.operationId || null
      );
      const outcome = await pollUntilQbConfirmed(dispatchRowId);
      if (outcome === "timeout") {
        logger.warn(`${LOG_PREFIX} Poll timed out for rowId=${dispatchRowId}`);
      }
    } else {
      await failPipelineRow(
        dispatchRowId,
        result.error ?? "QB Estimate MOD failed"
      );
    }
  };

  const serialized = withQbSerialized(
    `estimate:${draftOrderId}`,
    {
      orderId: draftOrderId,
      steps: ["estimate", "estimate_mod"],
      // Never wait on a row this call chain already owns: the consolidator's
      // claimed vehicle/mod row (excludeRowId) or our own dispatch row.
      excludeRowId: opts?.excludeRowId ?? dispatchRowId,
    },
    runCallback,
    { logger }
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
