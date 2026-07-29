import { getDbPool } from "../../../api/utils/db-pool";
import {
  getSoTxnId,
  getSoRef,
  getLatestInvoiceTxnId,
  getLatestInvoiceRef,
} from "../qb-metadata-types";
import {
  writePipelineRow,
  findInFlightQbRows,
  skipPipelineRowById,
} from "../qb-pipeline";
import { QbSyncLogger } from "../qb-sync-logger";

import { LOG_PREFIX } from "./utils";

export async function handleOrderCanceled(
  data: any,
  orderModule: any,
  logger: any
) {
  const orderId = data.id || data.order_id;
  logger.info(`${LOG_PREFIX} ── order.canceled → ${orderId} ──`);

  let order: any;
  try {
    order = await orderModule.retrieveOrder(orderId);
    logger.info(
      `${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`
    );
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`
    );
    return;
  }

  const meta = order.metadata || {};
  const soTxnId = getSoTxnId(meta);
  const soRef = getSoRef(meta);
  const invoiceTxnId = getLatestInvoiceTxnId(meta);
  const invoiceRef = getLatestInvoiceRef(meta);

  // Medusa-side reference for the order (e.g. "S10184")
  const soMedusaRef =
    (meta.document_number as string | undefined) ??
    (order.display_id ? `S${order.display_id}` : null);

  if (!soTxnId && !invoiceTxnId) {
    // No QB metadata yet — but the SO/Invoice/Estimate creation may be in-flight.
    // Strategy:
    //   - "waiting" rows haven't reached QB yet → skip them immediately (nothing to void)
    //   - "pending"/"submitted" rows are on their way to QB → chain a void to fire after confirmation
    let chainedCount = 0;
    let skippedCount = 0;
    try {
      const inFlight = await findInFlightQbRows(orderId, [
        "sales_order",
        "estimate",
        "invoice",
        "sales_receipt",
      ]);
      for (const inFlightRow of inFlight) {
        if (inFlightRow.status === "waiting") {
          // Document never reached QB — skip the row, no void needed.
          // Also stamp qb_sync_status=voided so the POS QB SYNCED badge shows VOIDED.
          await skipPipelineRowById(
            inFlightRow.id,
            `Order canceled before ${inFlightRow.step} reached QuickBooks`
          );
          try {
            await orderModule.updateOrders(orderId, {
              metadata: {
                ...(order.metadata || {}),
                qb_sync_status: "voided",
                voided_at: new Date().toISOString(),
              },
            });
          } catch {
            /* non-critical */
          }
          logger.info(
            `${LOG_PREFIX} ⏭ Skipped waiting ${inFlightRow.step} row ${inFlightRow.id} — stamped qb_sync_status=voided`
          );
          skippedCount++;
        } else {
          // pending/submitted — document is on its way to QB, chain a void after confirmation.
          // An "estimate" row is a draft order's Estimate — it may never become a Sales
          // Order (e.g. voided before conversion). Closing it via closeSalesOrderInQb
          // (SalesOrderQueryRq/Mod) fails permanently because that TxnID is an Estimate,
          // not a Sales Order in QB — route it through the existing estimate_deactivate
          // step instead (deactivateEstimateInQb), same as the SO-conversion path uses.
          // NO se encadena con `depends_on`. Se probó y no funciona:
          //
          //  - la fila hija nace sin `qb_txn_id` (acá todavía no existe), y
          //    `runWakeDependentsPass` sólo flipea el status — no copia el
          //    TxnID del padre. La hija despierta sin TxnID y muere en
          //    `resubmit-by-step` con "missing qb_txn_id — cannot void".
          //  - un padre que termina `skipped` o `failed` no despierta a nadie
          //    nunca, y `runOrphanedWaitingPass` sólo rescata `step='payment'`.
          //
          // Las dos únicas filas de void con `depends_on` que existieron en
          // producción terminaron ambas en `fixed`: las dos necesitaron mano.
          //
          // La intención de void ya es durable — la orden está `canceled` — y
          // `enqueueVoidIfAlreadyVoided` la materializa en el confirm del ADD,
          // que es el primer momento en que se conoce el TxnID.
          logger.info(
            `${LOG_PREFIX} ⏳ Void diferido — ${inFlightRow.step} row ${inFlightRow.id} sigue en vuelo (${inFlightRow.status}); ` +
              `se materializará al confirmar el ADD (ver pipeline/void-intent.ts)`
          );
          chainedCount++;
        }
      }
    } catch (chainErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check in-flight rows: ${chainErr.message}`
      );
    }

    if (chainedCount === 0 && skippedCount === 0) {
      logger.info(
        `${LOG_PREFIX} Order ${orderId} has no QB documents and no in-flight rows — nothing to cancel`
      );
    }
    return;
  }

  const docParts: string[] = [];
  if (soTxnId) docParts.push(`SO${soRef ? ` #${soRef}` : ` (${soTxnId})`}`);
  if (invoiceTxnId)
    docParts.push(
      `Invoice${invoiceRef ? ` #${invoiceRef}` : ` (${invoiceTxnId})`}`
    );
  const docLabel = docParts.join(", ");

  let logId: string | undefined;
  try {
    process.stdout.write(
      `[QB-CANCEL-LOG] Attempting QbSyncLogger.start for order ${orderId}, display_id=${order.display_id}\n`
    );
    logId = await QbSyncLogger.start({
      operation: "cancel",
      orderId,
      orderDisplayId: order.display_id,
      eventType: "order.canceled",
      message: `Cancelling ${docLabel} for Order #${order.display_id ?? orderId}`,
    });
    process.stdout.write(
      `[QB-CANCEL-LOG] QbSyncLogger.start succeeded: logId=${logId}\n`
    );
  } catch (logErr: any) {
    process.stderr.write(
      `[QB-CANCEL-LOG] QbSyncLogger.start FAILED: ${logErr?.code} | ${logErr?.message} | ${logErr?.stack?.slice(0, 300)}\n`
    );
    logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`);
  }

  // Section 1.5.14: enqueue-only. Consolidator (resubmit-by-step) picks up
  // pending rows and calls the bridge.
  let enqueuedSteps: string[] = [];

  if (invoiceTxnId) {
    // Guard: if there's already a voided Sales Receipt pos_invoice for this order,
    // handleInvoiceVoided (triggered by pos.invoice.voided) is handling the QB void
    // correctly as void_sales_receipt. Skip here to avoid a duplicate void_invoice.
    let skipInvoiceVoid = false;
    try {
      const pool = getDbPool();
      const { rows } = await pool.query(
        `SELECT id FROM pos_invoice
                 WHERE order_id = $1
                   AND status = 'voided'
                   AND metadata @> '{"is_sales_receipt": true}'
                 LIMIT 1`,
        [orderId]
      );
      if (rows.length > 0) {
        logger.info(
          `${LOG_PREFIX} Order ${orderId} has a voided Sales Receipt — QB void handled by handleInvoiceVoided, skipping void_invoice here`
        );
        skipInvoiceVoid = true;
      }
    } catch (checkErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check SR invoice status: ${checkErr.message}`
      );
    }

    if (!skipInvoiceVoid) {
      await writePipelineRow({
        orderId: orderId,
        step: "void_invoice",
        status: "pending",
        qbTxnId: invoiceTxnId,
        qbRefNumber: invoiceRef ?? null,
        medusaRefNumber: invoiceRef ?? null,
      });
      enqueuedSteps.push("void_invoice");
      logger.info(`${LOG_PREFIX} ✅ void_invoice enqueued (txn=${invoiceTxnId})`);
    }
  }

  if (soTxnId) {
    await writePipelineRow({
      orderId: orderId,
      step: "void_sales_order",
      status: "pending",
      qbTxnId: soTxnId,
      qbRefNumber: soRef ?? null,
      medusaRefNumber: soMedusaRef,
    });
    enqueuedSteps.push("void_sales_order");
    logger.info(`${LOG_PREFIX} ✅ void_sales_order enqueued (txn=${soTxnId})`);
  }

  if (logId) {
    try {
      const finalRef = soRef ?? invoiceRef;
      await QbSyncLogger.complete(logId, {
        qbTxnId: soTxnId ?? invoiceTxnId,
        qbRefNumber: finalRef,
        message: `${docLabel} void enqueued (${enqueuedSteps.join(", ")}) for Order #${order.display_id ?? orderId} — consolidator will submit`,
      });
    } catch (logErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not finalize sync log: ${logErr.message}`
      );
    }
  }
}
