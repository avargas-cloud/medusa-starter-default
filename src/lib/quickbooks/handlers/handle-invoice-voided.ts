import { getDbPool } from "../../../api/utils/db-pool";
import { FINANCE_MODULE } from "../../../modules/finance";
import { findInFlightQbRows } from "../pipeline/in-flight";
import { writePipelineRow } from "../qb-pipeline";
import { QbSyncLogger } from "../qb-sync-logger";

import { LOG_PREFIX } from "./utils";

export async function handleInvoiceVoided(
  data: any,
  orderModule: any,
  logger: any,
  _container?: any
) {
  const { order_id, invoice_id, fulfillment_id } = data;
  logger.info(
    `${LOG_PREFIX} ── pos.invoice.voided → Order ${order_id} | POS Invoice ${invoice_id} ──`
  );

  let order: any;
  try {
    order = await orderModule.retrieveOrder(order_id);
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${order_id}: ${err.message}`
    );
    return;
  }

  const qbInvoices = (order.metadata?.qb_invoices as any[]) || [];

  let targetInv = null;
  if (fulfillment_id) {
    targetInv = qbInvoices.find((inv) => inv.fulfillment_id === fulfillment_id);
  }

  if (!targetInv && qbInvoices.length > 0) {
    targetInv = qbInvoices[qbInvoices.length - 1];
  }

  if (!targetInv?.txn_id) {
    // Dos situaciones muy distintas comparten esta rama, y confundirlas es lo
    // que costó la POS Invoice 21246:
    //
    //   (a) el documento nunca fue a QB          → no hay nada que voidear
    //   (b) su ADD está EN VUELO ahora mismo     → el TxnID todavía no existe,
    //       pero el documento SÍ va a existir en QB dentro de unos segundos
    //
    // El evento `pos.invoice.voided` dispara una sola vez, así que en el caso
    // (b) un return mudo deja la factura viva y abierta en QB para siempre.
    // La intención de void NO se pierde: `pos_invoice.status='voided'` ya está
    // persistido, y `enqueueVoidIfAlreadyVoided` la materializa en el confirm
    // del ADD, que es el primer momento en que se conoce el TxnID.
    //
    // Acá sólo hace falta dejar rastro: sin esto el evento parece exitoso y la
    // divergencia es invisible hasta que alguien mira QuickBooks.
    let inFlight: Array<{ id: string; step: string; status: string }> = [];
    try {
      inFlight = await findInFlightQbRows(order_id, [
        "invoice",
        "sales_receipt",
      ]);
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check in-flight rows for ${order_id}: ${e.message}`
      );
    }

    if (inFlight.length > 0) {
      logger.info(
        `${LOG_PREFIX} ⏳ Void diferido — el create de ${invoice_id ?? order_id} sigue en vuelo ` +
          `(${inFlight.map((r) => `${r.step}:${r.status}`).join(", ")}); ` +
          `se materializará al confirmar el ADD (ver pipeline/void-intent.ts)`
      );
      try {
        await QbSyncLogger.start({
          operation: "void_invoice",
          orderId: order_id,
          orderDisplayId: order.display_id,
          eventType: "pos.invoice.voided",
          message: `Void diferido: el documento todavía se está creando en QB — se encolará al confirmar`,
        });
      } catch {
        /* el log no puede bloquear el flujo */
      }
      return;
    }

    logger.info(
      `${LOG_PREFIX} Order ${order_id} has no matching QB invoice to void.`
    );
    return;
  }

  const { txn_id: invoiceTxnId, ref_number: invoiceRef } = targetInv;

  let isSalesReceipt = false;
  let friendlyInvoiceId: string | undefined;
  try {
    const pool = getDbPool();
    const res = await pool.query(
      `SELECT invoice_number, metadata FROM pos_invoice WHERE id = $1`,
      [invoice_id]
    );
    if (res.rows[0]) {
      friendlyInvoiceId = res.rows[0].invoice_number;
      if (res.rows[0].metadata?.is_sales_receipt) {
        isSalesReceipt = true;
      }
    }
  } catch (e: any) {
    isSalesReceipt = invoiceRef?.startsWith("SR-") || false;
  }

  const documentTypeName = isSalesReceipt ? "Sales Receipt" : "Invoice";

  let logId: string | undefined;
  try {
    logId = await QbSyncLogger.start({
      operation: isSalesReceipt ? "void_sales_receipt" : "void_invoice",
      orderId: order_id,
      orderDisplayId: order.display_id,
      eventType: "pos.invoice.voided",
      message: `Voiding QB ${documentTypeName} ${invoiceRef ?? invoiceTxnId} for Order #${order.display_id}`,
    });
  } catch (logErr: any) {
    logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`);
  }

  logger.info(
    `${LOG_PREFIX} Voiding QB ${documentTypeName} ${invoiceTxnId}...`
  );

  // Inject pre-flight metadata so UI shows "VOIDING..."
  try {
    await orderModule.updateOrders(order_id, {
      metadata: { ...(order.metadata || {}), qb_sync_status: "voiding" },
    });
  } catch (mErr) {
    logger.warn(`${LOG_PREFIX} Could not set voiding status: ${mErr}`);
  }

  const pipelineStep = isSalesReceipt ? "void_sales_receipt" : "void_invoice";

  // Section 1.5.14: enqueue-only. Consolidator (resubmit-by-step) picks up
  // the pending row and calls voidInvoiceInQb / voidSalesReceiptInQb.
  // Failure to enqueue must surface (no try/warn swallow) so the event bus
  // retries — otherwise the void becomes invisible.
  await writePipelineRow({
    orderId: order_id,
    referenceId: invoice_id ?? null,
    referenceType: "pos_invoice",
    step: pipelineStep,
    status: "pending",
    qbTxnId: invoiceTxnId,
    qbRefNumber: invoiceRef ?? null,
    medusaRefNumber: friendlyInvoiceId ?? invoiceRef ?? invoice_id ?? null,
  });

  logger.info(
    `${LOG_PREFIX} ✅ ${documentTypeName} void enqueued (step=${pipelineStep})`
  );
  if (logId)
    await QbSyncLogger.complete(logId, {
      qbTxnId: invoiceTxnId,
      qbRefNumber: invoiceRef,
      message: `${documentTypeName} ${invoiceRef ?? invoiceTxnId} void enqueued — consolidator will submit`,
    });

  // Local cleanup (Medusa-side, independent of QB sync): if SR, void the
  // associated customer_payment record. Runs unconditionally because the
  // user-visible void in our DB has already happened.
  if (isSalesReceipt) {
    await voidSRPaymentIfExists({ invoice_id, logger, _container });
  }
}

/**
 * Finds the customer_payment linked to a Sales Receipt invoice (via qb_source='sales_receipt')
 * and marks it voided. Safe to call even if no SR payment exists.
 */
async function voidSRPaymentIfExists({
  invoice_id,
  logger,
  _container,
}: {
  invoice_id: string | undefined;
  logger: any;
  _container: any;
}) {
  if (!invoice_id || !_container) return;
  try {
    const financeService = _container.resolve(FINANCE_MODULE) as any;
    const pool = getDbPool();

    // Find the payment linked to this invoice via payment applications
    const res = await pool.query(
      `SELECT cp.id, cp.status, cp.metadata, cp.qb
             FROM customer_payment cp
             JOIN payment_application pa ON pa.payment_id = cp.id
             WHERE pa.invoice_id = $1
               AND (cp.metadata->>'qb_source' = 'sales_receipt'
                    OR cp.metadata->>'is_sales_receipt_payment' = 'true')
               AND cp.status != 'voided'
             LIMIT 1`,
      [invoice_id]
    );

    if (!res.rows[0]) {
      logger.info(
        `${LOG_PREFIX} No SR payment found for invoice ${invoice_id} to void`
      );
      return;
    }

    const payment = res.rows[0];
    await financeService.updateCustomerPayments({
      id: payment.id,
      status: "voided",
      metadata: {
        ...(payment.metadata || {}),
        qb_sync_status: "voided",
      },
      qb: {
        ...(payment.qb || {}),
        status: "voided",
      },
    });
    logger.info(
      `${LOG_PREFIX} ✅ SR Payment ${payment.id} voided alongside Sales Receipt ${invoice_id}`
    );
  } catch (err: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not void SR payment for invoice ${invoice_id}: ${err.message}`
    );
  }
}
