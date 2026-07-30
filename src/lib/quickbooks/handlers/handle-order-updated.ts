import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { updateSalesOrderInQb } from "../client/sales-orders";
import { buildQbItems, resolveProductTaxableMap, resolveLineTaxableMap, type MedusaOrderForQb } from "../order-flow-core";
import { parseSalesRepInitials } from "../parse-sales-rep";
import { getSoTxnId, getSoRef } from "../qb-metadata-types";
import {
  coalesceIfInFlight,
  writePipelineRow,
  pollUntilQbConfirmed,
} from "../qb-pipeline";
import { withQbSerialized } from "../qb-serializer";

/**
 * Handle Sales Order MOD (update existing QB Sales Order).
 *
 * Gold-standard sequential-save pattern (mirrors handle-draft-order-updated.ts):
 *   1. coalesceIfInFlight — if a prior SO MOD is still submitted, mark next_payload
 *      and return. Consolidator will resubmit after the prior op confirms.
 *   2. writePipelineRow(pending) — pre-flight row for immediate UI feedback.
 *   3. withQbSerialized — per-order in-memory lock + DB in-flight check to
 *      guarantee strictly sequential bridge calls.
 *   4. Inside the lock: idempotent re-reset to pending, then bridge MOD,
 *      then writePipelineRow(submitted) → pollUntilQbConfirmed or
 *      writePipelineRow(failed).
 *
 * Callable from:
 *   - post-edit-sync route (user-initiated edit)
 *   - consolidator resubmitByStep (coalesced save picked up after confirm)
 *   - pipeline retry endpoint (manual retry of failed MOD)
 *
 * Returns:
 *   - "coalesced" — next_payload was set on an in-flight row; nothing else to do.
 *   - "scheduled" — serialized callback was scheduled in the background.
 *   - "skipped"   — order has no qb_sales_order.txn_id (use CREATE path instead).
 */
export async function handleOrderUpdated(
  orderId: string,
  container: any,
  logger: any,
  opts?: { isCron?: boolean; awaitSerialized?: boolean }
): Promise<"coalesced" | "scheduled" | "skipped"> {
  const LOG_PREFIX = "[QB-ORDER-UPDATED]";
  const isCron = opts?.isCron ?? false;

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

  const qbTxnId = getSoTxnId(order.metadata);
  if (!qbTxnId) {
    logger.info(
      `${LOG_PREFIX} No qb_sales_order.txn_id on ${orderId} — cannot MOD (use CREATE)`
    );
    return "skipped";
  }

  const qbRef = getSoRef(order.metadata) ?? null;
  const medusaRef = order.display_id ? `S${order.display_id}` : null;

  // 1. Coalesce rapid saves — if a prior MOD is 'submitted', mark next_payload.
  if (!isCron) {
    const coalesced = await coalesceIfInFlight(orderId, null, "sales_order");
    if (coalesced) {
      logger.info(
        `${LOG_PREFIX} ⏸ SO MOD in-flight for ${orderId} — save coalesced into next_payload`
      );
      return "coalesced";
    }
  }

  // 2. Pre-flight pending row for UI.
  try {
    await writePipelineRow({
      orderId,
      step: "sales_order",
      status: "pending",
      intent: "mod",
      qbTxnId,
      qbRefNumber: qbRef,
      medusaRefNumber: medusaRef,
    });
    // Also reflect "pending" on the order metadata so the UI badge updates.
    try {
      await getDbPool().query(
        `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ qb_sync_status: "pending" }), orderId]
      );
    } catch {
      /* best-effort */
    }
  } catch (preErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${preErr.message}`
    );
  }

  const runCallback = async (): Promise<void> => {
    // Fetch freshest order state for MOD payload.
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
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });
    if (!fullOrder) {
      logger.warn(`${LOG_PREFIX} Order ${orderId} vanished before MOD`);
      return;
    }

    // Re-read the freshest qb_sales_order.txn_id from metadata inside the lock.
    // If it changed between pre-flight and execution (e.g. consolidator persisted
    // a new txnId after a CREATE confirm), we use the latest. Falls back to the
    // pre-flight value to avoid aborting on transient fetch glitches.
    const freshTxnId = getSoTxnId(fullOrder.metadata) ?? qbTxnId;
    const freshRef = getSoRef(fullOrder.metadata) ?? qbRef;

    // In-lock idempotent reset — guarantees writePipelineRow(submitted/failed) below
    // has a 'pending' row to UPDATE rather than INSERTing a duplicate under race.
    try {
      await writePipelineRow({
        orderId,
        step: "sales_order",
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
    const pgConn = container.resolve("__pg_connection__");
    const productTaxableMap = await resolveProductTaxableMap(
      pgConn,
      typedOrder.items || []
    );
    const lineTaxableMap = await resolveLineTaxableMap(
      pgConn,
      typedOrder.items || []
    );
    const qbItems = buildQbItems(
      typedOrder.items || [],
      typedOrder.metadata,
      productTaxableMap,
      lineTaxableMap
    );
    const salesRep = parseSalesRepInitials(fullOrder.metadata?.sales_rep);

    try {
      const result = await updateSalesOrderInQb({
        txnId: freshTxnId,
        items: qbItems,
        ...(salesRep ? { salesRep } : {}),
      });

      if (result.success) {
        const rowId = await writePipelineRow({
          orderId,
          step: "sales_order",
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
          orderId,
          step: "sales_order",
          status: "failed",
          qbTxnId: freshTxnId,
          qbRefNumber: freshRef,
          medusaRefNumber: medusaRef,
          error: result.error,
        });
        try {
          await getDbPool().query(
            `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"error"}'::jsonb WHERE id = $1`,
            [orderId]
          );
        } catch {
          /* best-effort */
        }
      }
    } catch (err: any) {
      logger.error(`${LOG_PREFIX} Exception during SO MOD: ${err.message}`);
      await writePipelineRow({
        orderId,
        step: "sales_order",
        status: "failed",
        qbTxnId: freshTxnId,
        qbRefNumber: freshRef,
        medusaRefNumber: medusaRef,
        error: err.message,
      });
      try {
        await getDbPool().query(
          `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"error"}'::jsonb WHERE id = $1`,
          [orderId]
        );
      } catch {
        /* best-effort */
      }
    }
  };

  const serialized = withQbSerialized(
    `sales_order:${orderId}`,
    { orderId, steps: ["sales_order"] },
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
