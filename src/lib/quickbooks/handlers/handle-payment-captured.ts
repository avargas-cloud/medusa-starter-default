/**
 * ⚠️ CÓDIGO MUERTO — no puede ejecutar trabajo. No lo tomes como referencia.
 *
 * Dos guards complementarios lo dejan sin ningún caso posible:
 *
 *   - `qb-order-subscriber.ts` sólo lo invoca si la orden ES del POS
 *     (`if (!isPosOrder(paymentOrder)) break;`).
 *   - este handler retorna inmediatamente si la orden ES del POS
 *     (`if (isPosOrder(order)) return;`).
 *
 * Las órdenes web nunca entran; las del POS entran y se van sin hacer nada.
 * La prueba está en los datos: de las 786 filas `step='payment'` en producción,
 * CERO carecen de `reference_id` — y este archivo escribe sin él. Nunca escribió
 * una sola fila.
 *
 * Los pagos REALES viven en otro lado:
 *   - POS → `handle-pos-payment-created.ts`
 *   - WEB → el hook de checkout `workflows/hooks/maintain-cart-prices.ts`
 *
 * Se documenta en vez de borrarlo porque su sola existencia ya costó un
 * diagnóstico equivocado: al leerlo se concluyó que el pago web no tenía un
 * `customer_payment` que referenciar y que por eso su void era imposible de
 * cubrir. Falso — el hook del checkout sí lo tiene, y hoy llama al
 * `enqueueVoidIfAlreadyVoided` como todos los demás caminos.
 *
 * Si algún día se borra, revisar antes `src/scripts/test/sandbox-smoke-*.ts`,
 * que lo nombran.
 */
import { processPaymentCaptureInQb } from "../order-flow-core";
import { resolveQbPaymentMethodForPayment } from "../payment-method-sanitizer";
import { applyPaymentToInvoiceInQb } from "../qb-bridge-client";
import { buildPaymentPatch, getLatestInvoiceTxnId } from "../qb-metadata-types";
import { writePipelineRow } from "../qb-pipeline";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";

import { LOG_PREFIX, isPosOrder } from "./utils";

export async function handlePaymentCaptured(
  data: any,
  orderModule: any,
  _customerModule: any,
  logger: any
) {
  const orderId = data.id || data.order_id;
  logger.info(
    `${LOG_PREFIX} ── order.payment_captured → orderId=${orderId} ──`
  );
  logger.info(`${LOG_PREFIX} Payment event data: ${JSON.stringify(data)}`);

  let order: any;
  try {
    order = await orderModule.retrieveOrder(orderId);
    logger.info(
      `${LOG_PREFIX} Order fetched: #${order.display_id}, customer_id=${order.customer_id}`
    );
    logger.info(
      `${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`
    );
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`
    );
    return;
  }

  if (isPosOrder(order)) {
    logger.info(
      `${LOG_PREFIX} ⏭️ Skipping order.payment_captured for POS order ${orderId}. Payment is handled by pos.payment.created event.`
    );
    return;
  }

  // Live customer wins over the order-metadata cache (re-stamped on drift).
  // The resolver fetches the live customer ListID itself — this handler's
  // order fetch does not embed the customer.
  const qbCustomerId: string | undefined = await resolveOrderQbCustomer({
    orderId,
    cachedListId: (order.metadata?.qb_list_id as string | undefined) ?? null,
    logger,
  });

  if (!qbCustomerId) {
    logger.warn(
      `${LOG_PREFIX} ❌ No qb_list_id found for order ${orderId} — QB Sales Order must exist first. Skipping payment.`
    );
    logger.warn(
      `${LOG_PREFIX} This usually means order.placed failed or the QB SO was not yet created.`
    );
    return;
  }

  logger.info(`${LOG_PREFIX} Using qb_list_id=${qbCustomerId}`);

  const amountInCents = data.amount ?? order.total ?? 0;
  const amount = amountInCents / 100;
  logger.info(`${LOG_PREFIX} Payment amount: $${amount.toFixed(2)}`);

  // This handler only fires in edge cases (non-POS orders whose payment event
  // bypasses the maintain-cart-prices hook). Web checkout is Credit Card via
  // Authorize.Net, so that's the safe default — but if the event payload
  // surfaces a specific method / brand, we use the canonical helper to honor
  // the split-aware rule: credit_card → card_brand, else → payment_method.
  const rawMethod = (data.payment_method ?? data.method) as string | undefined;
  const rawBrand = (data.card_brand ?? data.metadata?.card_brand) as
    | string
    | undefined;
  const paymentMethod =
    resolveQbPaymentMethodForPayment(rawMethod, rawBrand) ?? "Credit Card";

  // Write "pending" pipeline row immediately so it appears in the UI before polling starts
  try {
    await writePipelineRow({ orderId, step: "payment", status: "pending" });
  } catch (pErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  const result = await processPaymentCaptureInQb({
    orderId,
    orderDisplayId: order.display_id,
    amount,
    paymentMethod,
    qbCustomerId,
    onSubmitted: async (operationId) => {
      await writePipelineRow({
        orderId,
        step: "payment",
        status: "submitted",
        bridgeOpId: operationId,
      });
    },
  });

  if (result.skipped) {
    logger.info(`${LOG_PREFIX} ⏭️ Payment skipped (QB disabled)`);
    return;
  }
  if (result.error) {
    logger.error(
      `${LOG_PREFIX} ❌ processPaymentCaptureInQb error: ${result.error}`
    );
    try {
      await writePipelineRow({
        orderId,
        step: "payment",
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

  if (result.txnId || result.operationId) {
    // Record payment in pipeline
    try {
      await writePipelineRow({
        orderId,
        step: "payment",
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

    const latestInvoiceTxnId = getLatestInvoiceTxnId(order.metadata);

    if (result.txnId && latestInvoiceTxnId && result.editSequence) {
      logger.info(
        `${LOG_PREFIX} Auto-applying new payment ${result.txnId} to latest Invoice ${latestInvoiceTxnId}...`
      );
      const applyResult = await applyPaymentToInvoiceInQb({
        customerId: qbCustomerId,
        amount: amount,
        invoiceId: latestInvoiceTxnId,
        creditTxnId: result.txnId,
        editSequence: result.editSequence,
      });
      if (!applyResult.success) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Failed to apply payment to invoice: ${applyResult.error}`
        );
      } else {
        logger.info(
          `${LOG_PREFIX} ✅ Payment successfully applied to Invoice.`
        );
      }
    }

    try {
      const baseMeta = { ...(order.metadata || {}), qb_list_id: qbCustomerId };
      const patch = buildPaymentPatch(baseMeta, {
        txnId: result.txnId || null,
        refNumber: result.refNumber || null,
        operationId: result.operationId || null,
        amount,
        method: paymentMethod,
      });
      await orderModule.updateOrders(orderId, { metadata: patch });
      logger.info(
        `${LOG_PREFIX} ✅ Saved payment metadata — TxnID=${result.txnId}, Ref=${result.refNumber}`
      );
    } catch (metaErr: any) {
      logger.error(
        `${LOG_PREFIX} ⚠️ Failed to save payment metadata: ${metaErr.message}`
      );
    }
  }
}
