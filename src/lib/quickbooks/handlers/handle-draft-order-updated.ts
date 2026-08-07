import { ContainerRegistrationKeys } from "@medusajs/utils";

import { updateEstimateInQb } from "../client/estimates";
import { buildQbItems, resolveProductTaxableMap, type MedusaOrderForQb } from "../order-flow-core";
import { parseSalesRepInitials } from "../parse-sales-rep";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";
import { getEstimateTxnId, getEstimateRef } from "../qb-metadata-types";
import {
  coalesceIfInFlight,
  writePipelineRow,
  pollUntilQbConfirmed,
} from "../qb-pipeline";
import { withQbSerialized } from "../qb-serializer";

/**
 * Handle Estimate MOD (update existing QB Estimate).
 *
 * Gold-standard sequential-save pattern:
 *   1. coalesceIfInFlight — if a prior save is still submitted, mark next_payload
 *      on the existing row and return. The consolidator will resubmit this call
 *      after the prior op confirms (claimAndResetForResubmit → resubmitByStep).
 *   2. writePipelineRow(pending) — idempotent pre-flight row for UI feedback.
 *   3. withQbSerialized — per-order in-memory lock + DB in-flight check to
 *      guarantee strictly sequential bridge calls.
 *   4. Inside the lock: writePipelineRow(pending) again (idempotent under lock),
 *      then bridge MOD, then writePipelineRow(submitted) → pollUntilQbConfirmed
 *      or writePipelineRow(failed).
 *
 * Callable from:
 *   - sync-pos route (user-initiated save)
 *   - consolidator resubmitByStep (coalesced save picked up after confirm)
 *   - pipeline retry endpoint (manual retry of failed MOD)
 *
 * Returns:
 *   - "coalesced" — next_payload was set on an in-flight row; nothing else to do.
 *   - "scheduled" — serialized callback was scheduled in the background.
 *   - "skipped"   — draft order has no qb_estimate_txn_id (use CREATE path instead).
 */
export async function handleDraftOrderUpdated(
  draftOrderId: string,
  container: any,
  logger: any,
  opts?: { isCron?: boolean; awaitSerialized?: boolean }
): Promise<"coalesced" | "scheduled" | "skipped"> {
  const LOG_PREFIX = "[QB-DRAFT-ORDER-UPDATED]";
  const isCron = opts?.isCron ?? false;

  // Fetch draft order to confirm it has a qb_estimate_txn_id (MOD path requires it)
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

  const qbTxnId = getEstimateTxnId(draftOrder.metadata);
  if (!qbTxnId) {
    logger.info(
      `${LOG_PREFIX} No qb_estimate_txn_id on ${draftOrderId} — cannot MOD (use CREATE)`
    );
    return "skipped";
  }

  const qbRef = getEstimateRef(draftOrder.metadata) ?? null;
  const medusaRef = draftOrder.display_id ? `E${draftOrder.display_id}` : null;

  // 1. Coalesce if a prior save is still submitted/in-flight.
  //    Skip for cron (consolidator resubmit): isCron means we're already RESUMING a
  //    coalesced save, so coalescing again would make it loop forever.
  if (!isCron) {
    const coalesced = await coalesceIfInFlight(draftOrderId, null, "estimate");
    if (coalesced) {
      logger.info(
        `${LOG_PREFIX} ⏸ Estimate MOD in-flight for ${draftOrderId} — save coalesced into next_payload`
      );
      return "coalesced";
    }
  }

  // 2. Pre-flight pending row for immediate UI visibility
  try {
    await writePipelineRow({
      orderId: draftOrderId,
      step: "estimate",
      status: "pending",
      intent: "mod",
      qbTxnId,
      qbRefNumber: qbRef,
      medusaRefNumber: medusaRef,
    });
  } catch (preErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${preErr.message}`
    );
  }

  // 3. Schedule the serialized bridge call.
  const runCallback = async (): Promise<void> => {
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
      return;
    }

    // Re-read qb_txn_id from the freshly-fetched metadata. If it changed
    // between the pre-flight fetch and the in-lock execution (e.g. the
    // consolidator just persisted a new txnId after a prior CREATE confirmed),
    // we use the latest value. Falls back to the pre-flight value so we never
    // abort MOD on a transient fetch glitch.
    const freshTxnId = getEstimateTxnId(fullOrder.metadata) ?? qbTxnId;
    const freshRef = getEstimateRef(fullOrder.metadata) ?? qbRef;

    // Inside the lock: idempotent reset to pending (serialized guarantee
    // that writePipelineRow(failed/submitted) below has a pending row to match).
    try {
      await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: "pending",
        intent: "mod",
        qbTxnId: freshTxnId,
        qbRefNumber: freshRef,
        medusaRefNumber: medusaRef,
      });
    } catch (lockErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ In-lock pending reset failed: ${lockErr.message}`
      );
    }

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
      const rowId = await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: "submitted",
        bridgeOpId: result.data?.operationId || null,
        qbTxnId: freshTxnId,
        qbRefNumber: freshRef,
        medusaRefNumber: medusaRef,
      });
      const outcome = await pollUntilQbConfirmed(rowId);
      if (outcome === "timeout") {
        logger.warn(`${LOG_PREFIX} Poll timed out for rowId=${rowId}`);
      }
    } else {
      await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: "failed",
        qbTxnId: freshTxnId,
        qbRefNumber: freshRef,
        medusaRefNumber: medusaRef,
        error: result.error,
      });
    }
  };

  const serialized = withQbSerialized(
    `estimate:${draftOrderId}`,
    { orderId: draftOrderId, steps: ["estimate"] },
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
