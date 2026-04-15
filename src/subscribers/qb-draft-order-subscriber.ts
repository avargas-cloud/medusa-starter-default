/**
 * qb-draft-order-subscriber.ts
 *
 * Event-driven subscriber that creates QB Estimates when
 * Draft Orders are created in Medusa Admin.
 *
 * Events handled:
 *   - draft_order.created → Create Estimate in QB
 *
 * When a Draft Order is later confirmed → converted to a real Order,
 * the `order.placed` event fires and qb-order-subscriber detects
 * the estimate via `qb_estimate_txn_id` in metadata, then converts
 * the Estimate into a Sales Order automatically.
 *
 * DISABLED BY DEFAULT: Set QB_ORDER_FLOW_ENABLED=true to activate.
 *
 * Metadata stored on draft order:
 *   qb_estimate_txn_id, qb_estimate_ref, qb_list_id (customer QB ID)
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";

import {
  ensureCustomerInQb,
  buildQbItems,
  buildQbOrderDiscountLines,
  processEstimateInQb,
} from "../lib/quickbooks/order-flow-core";
import { parseSalesRepInitials } from "../lib/quickbooks/parse-sales-rep";
import { buildEstimatePatch } from "../lib/quickbooks/qb-metadata-types";
import {
  coalesceIfInFlight,
  writePipelineRow,
  cacheEditSequence,
} from "../lib/quickbooks/qb-pipeline";

const LOG_PREFIX = "[QB-DRAFT]";
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";

// Sales Channel IDs from .env
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? "";

/** Returns true if the order was placed through the POS sales channel */
function isPosOrder(order: any): boolean {
  // Primary check: sales channel ID (set via POS_SALES_CHANNEL_ID env var)
  if (POS_CHANNEL_ID && order.sales_channel_id === POS_CHANNEL_ID) return true;
  // Fallback: metadata flag set by POS app — stored as string "true" or boolean true
  const posCreated = order.metadata?.pos_created;
  if (posCreated === true || posCreated === "true") return true;
  return false;
}

// ─── Subscriber Handler ─────────────────────────────────────────────────────

async function qbDraftOrderSubscriber({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  // ── Guard: feature flag ──────────────────────────────────────────────────
  if (!ENABLED) {
    logger.info(
      `${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`
    );
    return;
  }

  logger.info(
    `${LOG_PREFIX} 📥 Received event: ${event.name} | data: ${JSON.stringify(event.data)}`
  );

  try {
    if (event.name === "draft_order.created") {
      await handleDraftOrderCreated(event.data, container, logger);
    }
  } catch (err: any) {
    // QB failures must NEVER block the Medusa flow
    logger.error(
      `${LOG_PREFIX} ❌ Unhandled exception in ${event.name}: ${err.message}`
    );
    logger.error(`${LOG_PREFIX} Stack: ${err.stack}`);
  }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

export async function handleDraftOrderCreated(
  data: any,
  container: any,
  logger: any,
  isCron: boolean = false
) {
  const draftOrderId = data.id;
  logger.info(`${LOG_PREFIX} ── draft_order.created → ${draftOrderId} ──`);

  // next_payload coalescing: if this estimate is already submitted (in-flight),
  // mark next_payload on the existing row and return — no duplicate bridge call.
  // The consolidator will reset the row and call us again once the current op confirms.
  //
  // Skip coalescing for cron calls: the cron should only run when no submitted row
  // exists (guard below), so coalescing is a no-op there and we fall through normally.
  if (!isCron) {
    try {
      const coalesced = await coalesceIfInFlight(draftOrderId, null, "estimate");
      if (coalesced) {
        logger.info(
          `${LOG_PREFIX} ⏸ Estimate in-flight for ${draftOrderId} — coalesced as next submit`
        );
        return;
      }
    } catch (coalErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check coalesce state: ${coalErr.message}`
      );
    }
  }

  // Hard guard for cron: skip if already submitted or confirmed (nothing to do).
  // 'waiting' is intentionally excluded — the cron's job IS to process waiting rows.
  if (isCron) {
    try {
      const { getDbPool } = require("../api/utils/db-pool");
      const pool = getDbPool();
      const { rows: existing } = await pool.query(
        `SELECT status FROM qb_order_pipeline
               WHERE order_id = $1 AND step = 'estimate'
                 AND status IN ('submitted', 'confirmed')
               LIMIT 1`,
        [draftOrderId]
      );
      if (existing.length > 0) {
        logger.info(
          `${LOG_PREFIX} ⏭️ Estimate already ${existing[0].status} for ${draftOrderId} — cron skipping`
        );
        return;
      }
    } catch (dupErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check pipeline status: ${dupErr.message}`
      );
    }
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const customerModule = container.resolve(Modules.CUSTOMER);

  // Fetch draft order with items + customer
  let draftOrder: any;
  try {
    const { data: results } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "sales_channel_id",
        "metadata",
        "subtotal",
        "discount_total",
        "customer.*",
        "customer.metadata",
        "customer.addresses.*",
        "items.*",
        "items.variant.*",
        "items.variant.metadata",
      ],
      filters: { id: draftOrderId },
    });
    draftOrder = results?.[0];
  } catch (fetchErr: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch draft order: ${fetchErr.message}`
    );
    return;
  }

  if (!draftOrder) {
    logger.warn(`${LOG_PREFIX} Draft order ${draftOrderId} not found`);
    return;
  }

  logger.info(
    `${LOG_PREFIX} Draft order metadata: ${JSON.stringify(draftOrder.metadata || {})}`
  );
  logger.info(
    `${LOG_PREFIX} Draft order items: ${draftOrder.items?.length ?? 0}`
  );

  // POS guard
  // POS Draft Orders do not sync to QB immediately. They are picked up by a cron job 1 hour later,
  // unless they are converted to a real order before then.
  if (!isCron && isPosOrder(draftOrder)) {
    logger.info(
      `${LOG_PREFIX} ⏭️ POS Draft Order — QB sync delayed by 1 hour (handled by cron), skipping subscriber`
    );
    const friendlyRef =
      (draftOrder.metadata?.document_number as string | undefined) ||
      (draftOrder.display_id ? `E${draftOrder.display_id}` : undefined);
    try {
      await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: "waiting",
        medusaRefNumber: friendlyRef ?? null,
      });
      logger.info(
        `${LOG_PREFIX} ✅ Wrote waiting pipeline row for ${draftOrderId} (${friendlyRef ?? "no ref"})`
      );
    } catch (pErr: any) {
      logger.error(
        `${LOG_PREFIX} ❌ Could not write waiting pipeline row: ${pErr.message}`
      );
    }
    return;
  }

  // Ensure customer in QB
  const customer = draftOrder.customer;
  if (!customer) {
    logger.warn(`${LOG_PREFIX} Draft order has no customer — skipping`);
    return;
  }

  logger.info(
    `${LOG_PREFIX} Customer: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`
  );

  const custResult = await ensureCustomerInQb(customer, customerModule, (msg) =>
    logger.info(msg)
  );
  if (!custResult.success) {
    logger.error(`${LOG_PREFIX} ❌ Customer check failed: ${custResult.error}`);
    return;
  }

  logger.info(
    `${LOG_PREFIX} ✅ Customer in QB: qb_list_id=${custResult.qbCustomerId}`
  );

  // Build QB items — query.graph returns unit_price in DOLLARS; buildQbItems also expects DOLLARS
  const qbItems = buildQbItems(draftOrder.items || [], draftOrder.metadata);

  const orderDiscountDollars = draftOrder.discount_total || 0;
  if (orderDiscountDollars > 0) {
    const orderSubtotal = draftOrder.subtotal || 0;
    const discountPercent =
      orderSubtotal > 0 ? (orderDiscountDollars / orderSubtotal) * 100 : null;
    buildQbOrderDiscountLines(orderDiscountDollars, discountPercent).forEach(
      (l) => qbItems.push(l)
    );
  }

  logger.info(
    `${LOG_PREFIX} QB-linked items: ${qbItems.length} of ${draftOrder.items?.length ?? 0} total`
  );

  if (qbItems.length === 0) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ No QB-linked items in draft order — skipping Estimate`
    );
    logger.warn(
      `${LOG_PREFIX} Items need variant.metadata.quickbooks_id to be synced`
    );
    return;
  }

  // Log each item being sent to QB
  qbItems.forEach((item, i) => {
    logger.info(
      `${LOG_PREFIX} Item[${i}]: productId=${item.productId}, qty=${item.quantity}, price=$${item.price}, uom=${item.unitOfMeasure ?? "none"}`
    );
  });

  // Write "pending" pipeline row immediately so it appears in the UI before polling starts
  // (also transitions any existing "waiting" row to "pending" in-place)
  const friendlyEstRef =
    (draftOrder.metadata?.document_number as string | undefined) ||
    (draftOrder.display_id ? `E${draftOrder.display_id}` : undefined);
  try {
    await writePipelineRow({
      orderId: draftOrderId,
      step: "estimate",
      status: "pending",
      medusaRefNumber: friendlyEstRef ?? null,
    });
  } catch (pErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  // Create Estimate
  // NOTE: no onSubmitted callback here — the post-result writePipelineRow below
  // already records the submitted/confirmed status with bridgeOpId. Having both
  // would INSERT two separate rows for the same operation, causing the consolidator
  // to confirm duplicates.
  const result = await processEstimateInQb({
    draftOrderId,
    qbCustomerId: custResult.qbCustomerId!,
    items: qbItems,
    memo:
      (draftOrder.metadata?.document_number as string) ||
      `E${draftOrder.display_id}`,
    salesRep: parseSalesRepInitials(draftOrder.metadata?.sales_rep),
  });

  if (result.error) {
    logger.error(`${LOG_PREFIX} ❌ processEstimateInQb error: ${result.error}`);
    try {
      await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: "failed",
        error: result.error,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
      );
    }
    return;
  }

  if (result.skipped) {
    logger.info(`${LOG_PREFIX} ⏭️ Estimate skipped (QB disabled or no items)`);
    return;
  }

  logger.info(
    `${LOG_PREFIX} ✅ Estimate created — TxnID=${result.txnId}, Ref=${result.refNumber}, OpID=${result.operationId}`
  );

  // Save estimate metadata to draft order
  if (result.txnId || result.operationId) {
    // Record in pipeline
    try {
      await writePipelineRow({
        orderId: draftOrderId,
        step: "estimate",
        status: result.operationId && !result.txnId ? "submitted" : "confirmed",
        bridgeOpId: result.operationId || null,
        qbTxnId: result.txnId || null,
        qbRefNumber: result.refNumber || null,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
      );
    }

    try {
      const orderModule = container.resolve(Modules.ORDER);
      const currentMetadata = draftOrder.metadata || {};

      // Determine sync status: "pending" if still waiting for QBWC, "synced" if already confirmed
      const isAsync = !!result.operationId && !result.txnId;
      const patch = buildEstimatePatch(
        { ...currentMetadata, qb_list_id: custResult.qbCustomerId },
        {
          txnId: result.txnId || "",
          refNumber: result.refNumber || null,
          operationId: result.operationId || null,
          editSequence: result.editSequence || null,
          syncStatus: isAsync ? "pending" : "synced",
        }
      );

      // Cache EditSequence so future Mod ops skip the GET round-trip
      if (result.editSequence && result.txnId) {
        try {
          await cacheEditSequence(
            "estimate",
            result.txnId,
            result.editSequence
          );
          logger.info(
            `${LOG_PREFIX} ✅ Cached EditSequence for Estimate TxnID=${result.txnId}`
          );
        } catch (cacheErr: any) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Could not cache EditSequence: ${cacheErr.message}`
          );
        }
      }

      await orderModule.updateOrders(draftOrderId, { metadata: patch });
      logger.info(
        `${LOG_PREFIX} ✅ Saved estimate metadata to draft order ${draftOrderId} (status=${isAsync ? "pending" : "synced"})`
      );
    } catch (metaErr: any) {
      logger.error(
        `${LOG_PREFIX} ⚠️ Failed to save draft order metadata: ${metaErr.message}`
      );
      logger.error(
        `${LOG_PREFIX} ⚠️ QB Estimate WAS created (TxnID=${result.txnId}) but metadata not saved. Manual update needed.`
      );
    }
  }
}

// ─── Subscriber Configuration ────────────────────────────────────────────────

export default qbDraftOrderSubscriber;

export const config: SubscriberConfig = {
  event: ["draft_order.created"],
  context: {
    subscriberId: "qb-draft-order-subscriber",
  },
};
