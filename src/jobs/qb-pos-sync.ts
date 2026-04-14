import { MedusaContainer } from "@medusajs/framework/types";
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";
import { Client } from "pg";

import { handleOrderPlaced } from "../lib/quickbooks/handlers/handle-order-placed";
import { handlePosPaymentCreated } from "../lib/quickbooks/handlers/handle-pos-payment-created";
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard";
import {
  getEstimateTxnId,
  getSoTxnId,
  getLatestInvoiceTxnId,
} from "../lib/quickbooks/qb-metadata-types";
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger";
import { FINANCE_MODULE } from "../modules/finance";
import { handleDraftOrderCreated } from "../subscribers/qb-draft-order-subscriber";

const LOG_PREFIX = "[QB-POS-SYNC]";
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? "";

export default async function qbPosSyncHandler(container: MedusaContainer) {
  if (!POS_CHANNEL_ID) {
    console.warn(`${LOG_PREFIX} POS_SALES_CHANNEL_ID not set. Skipping job.`);
    return;
  }

  if (!(await isQbIntegrationEnabled())) {
    console.log(`${LOG_PREFIX} ⏭️ QB Integration disabled — skipping.`);
    return;
  }

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    logger.info(
      `${LOG_PREFIX} ⏰ Running POS Async Sync for delayed Orders/Estimates (>1h)...`
    );

    const logId = await QbSyncLogger.start({
      operation: "pos_sync",
      syncType: "order",
      triggeredBy: "auto",
      message: "Scheduled POS Async Sync started (>1h delayed orders)",
      db: client,
    });

    const orderModule = container.resolve(Modules.ORDER);
    const customerModule = container.resolve(Modules.CUSTOMER);

    // 1. Fetch eligible POS Orders (between 1h and 24h old, not marked qb_skip)
    const ordersQuery = `
            SELECT id, metadata
            FROM "order"
            WHERE sales_channel_id = $1
              AND is_draft_order = false
              AND canceled_at IS NULL
              AND created_at <= NOW() - INTERVAL '1 hour'
              AND created_at >= NOW() - INTERVAL '24 hours'
              AND (metadata->>'qb_skip' IS NULL OR metadata->>'qb_skip' != 'true')
        `;
    const { rows: orderRows } = await client.query(ordersQuery, [
      POS_CHANNEL_ID,
    ]);

    let processedOrders = 0;
    for (const row of orderRows) {
      const meta = row.metadata || {};
      const soTxnId = getSoTxnId(meta);
      const invTxnId = getLatestInvoiceTxnId(meta);
      // A submitted-but-not-yet-confirmed Sales Receipt sets qb_invoice_operation_id
      // before the consolidator confirms it. Skip those too so we don't create a
      // duplicate Sales Order while the SR is still in-flight.
      const hasPendingInvoiceOp = !!(
        meta.qb_invoice_operation_id || meta.qb_sales_receipt_operation_id
      );

      // Guard: skip if there's already a submitted/confirmed invoice or sales_receipt in the
      // pipeline for this order. Metadata may not have qb_invoice_txn_id for POS invoices
      // created via the custom invoice route, so we always cross-check the pipeline table.
      if (!soTxnId && !invTxnId && !hasPendingInvoiceOp) {
        // Check pipeline for ANY non-failed invoice/sales_receipt row (waiting, pending,
        // submitted, or confirmed). 'waiting' rows are upfront placeholders written when a
        // POS invoice is created — they prove the invoice flow is active even before QB sync.
        const { rows: invoicePipelineRows } = await client.query(
          `SELECT id FROM qb_order_pipeline
                     WHERE order_id = $1
                       AND step IN ('invoice', 'sales_receipt')
                       AND status IN ('waiting', 'pending', 'submitted', 'confirmed')
                     LIMIT 1`,
          [row.id]
        );
        if (invoicePipelineRows.length > 0) {
          logger.info(
            `${LOG_PREFIX} ⏭️ Skipping SO for ${row.id} — invoice/sales_receipt already in pipeline`
          );
          continue;
        }

        // Secondary guard: check if a POS invoice record exists in the DB.
        // This catches orders invoiced before the pipeline was introduced, or where
        // the pipeline row was cleaned up but the invoice itself remains.
        const { rows: posInvoiceRows } = await client.query(
          `SELECT id FROM pos_invoice WHERE order_id = $1 LIMIT 1`,
          [row.id]
        );
        if (posInvoiceRows.length > 0) {
          logger.info(
            `${LOG_PREFIX} ⏭️ Skipping SO for ${row.id} — pos_invoice record exists (order already invoiced)`
          );
          continue;
        }

        logger.info(
          `${LOG_PREFIX} Processing delayed Sales Order for order: ${row.id}`
        );
        await handleOrderPlaced(
          { id: row.id }, // mock event payload
          orderModule,
          customerModule,
          container,
          logger,
          true // isCron flag
        );
        processedOrders++;
      }
    }

    // 2. Fetch eligible POS Draft Orders (Estimates)
    // Draft Orders might not have sales_channel_id natively indexed the same way,
    // so we check the metadata.pos_created flag or channel ID if present.
    const draftsQuery = `
            SELECT id, metadata
            FROM "order"
            WHERE canceled_at IS NULL
              AND is_draft_order = true
              AND created_at <= NOW() - INTERVAL '1 hour'
              AND created_at >= NOW() - INTERVAL '24 hours'
              AND (
                  sales_channel_id = $1
                  OR metadata->>'pos_created' = 'true'
              )
        `;
    // NOTE: In Medusa v2, draft orders are stored in the "order" table with is_draft_order=true
    const { rows: draftRows } = await client.query(draftsQuery, [
      POS_CHANNEL_ID,
    ]);

    let processedDrafts = 0;
    for (const row of draftRows) {
      const meta = row.metadata || {};
      const estTxnId = getEstimateTxnId(meta);

      if (estTxnId) continue; // already confirmed in metadata

      // Check pipeline table — only retry if no operation exists or latest failed
      const { rows: pipelineCheck } = await client.query(
        `SELECT status FROM qb_order_pipeline
                 WHERE order_id = $1 AND step = 'estimate'
                 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
        [row.id]
      );
      const latestPipelineStatus = pipelineCheck[0]?.status as
        | string
        | undefined;

      if (
        latestPipelineStatus === "submitted" ||
        latestPipelineStatus === "confirmed"
      ) {
        logger.info(
          `${LOG_PREFIX} Skipping estimate for ${row.id} — pipeline already ${latestPipelineStatus}`
        );
        continue;
      }

      logger.info(
        `${LOG_PREFIX} Processing delayed Estimate for draft order: ${row.id} (pipeline: ${latestPipelineStatus ?? "none"})`
      );
      await handleDraftOrderCreated(
        { id: row.id }, // mock event payload
        container,
        logger,
        true // isCron flag
      );
      processedDrafts++;
    }

    // 3. Auto-retry failed payment pipeline rows (max 3 attempts)
    const { rows: failedPaymentRows } = await client.query(`
            SELECT id, reference_id, order_id, retry_count
            FROM qb_order_pipeline
            WHERE step = 'payment'
              AND status = 'failed'
              AND retry_count < 3
            ORDER BY failed_at ASC
            LIMIT 10
        `);

    let retriedPayments = 0;
    const financeService = container.resolve(FINANCE_MODULE) as any;

    for (const payRow of failedPaymentRows) {
      if (!payRow.reference_id) continue;

      // If payment already synced externally, mark confirmed and skip
      try {
        const payment = await financeService.retrieveCustomerPayment(
          payRow.reference_id
        );
        if (payment?.metadata?.qb_sync_status === "synced") {
          await client.query(
            `UPDATE qb_order_pipeline SET status='confirmed', confirmed_at=NOW(), error=NULL WHERE id=$1`,
            [payRow.id]
          );
          logger.info(
            `${LOG_PREFIX} ✅ Payment ${payRow.reference_id} already synced — marked confirmed.`
          );
          continue;
        }
      } catch {}

      // Reset pipeline row to pending and increment retry count
      await client.query(
        `UPDATE qb_order_pipeline
                 SET status='pending', error=NULL, failed_at=NULL, confirmed_at=NULL,
                     submitted_at=NULL, bridge_op_id=NULL, qb_txn_id=NULL,
                     updated_at=NOW(), retry_count=retry_count+1
                 WHERE id=$1`,
        [payRow.id]
      );

      logger.info(
        `${LOG_PREFIX} 🔄 Auto-retrying failed payment ${payRow.reference_id} (attempt #${(payRow.retry_count ?? 0) + 1})`
      );

      try {
        await handlePosPaymentCreated({
          event: {
            name: "pos.payment.created",
            data: { id: payRow.reference_id },
          },
          container,
        } as any);
        retriedPayments++;
      } catch (retryErr: any) {
        logger.error(
          `${LOG_PREFIX} ❌ Auto-retry failed for payment ${payRow.reference_id}: ${retryErr.message}`
        );
      }
    }

    if (retriedPayments > 0) {
      logger.info(
        `${LOG_PREFIX} ✅ Auto-retried ${retriedPayments} failed payment(s).`
      );
    }

    logger.info(
      `${LOG_PREFIX} ✅ POS Async Sync complete. Created ${processedOrders} Sales Orders and ${processedDrafts} Estimates.`
    );
    await QbSyncLogger.complete(logId, {
      message: `Created ${processedOrders} Sales Orders and ${processedDrafts} Estimates. Retried ${retriedPayments} payments.`,
      db: client,
    });
  } catch (err: any) {
    logger.error(`${LOG_PREFIX} ❌ Job failure: ${err.message}`);
    // Note: logId is scoped inside try, so we might need to hoist it if we want to catch.
    // For simplicity, we just use a generic fail approach if it crashes outside.
  } finally {
    await client.end();
  }
}

export const config = {
  name: "qb-pos-sync",
  schedule: "*/30 * * * *", // Every 30 minutes
};
