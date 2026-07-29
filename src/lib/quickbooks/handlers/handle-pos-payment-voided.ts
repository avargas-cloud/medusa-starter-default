import { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";
import { bridgeFetch, pollRawOperationResult } from "../client/core";
import { findInFlightQbRowsByRef } from "../pipeline/in-flight";
import { writePipelineRow } from "../qb-pipeline";

const LOG_PREFIX = "[QB-POS-PAYMENT-VOIDED]";
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";

/**
 * Hard-deletes the ReceivePayment on the QB Bridge for a voided POS payment.
 * Called directly (setTimeout) from POST /admin/finance/payments/:id/void.
 *
 * QB Desktop does NOT support TxnVoid for ReceivePayment (Error 3110 — the
 * enumerated value is invalid for the qbXML version in use), so the bridge's
 * /api/payments/:txnId/void route issues a TxnDel (hard delete). We POLL the
 * operation result and only mark the payment qb_sync_status='voided' once QB
 * confirms the delete; on failure we mark 'error' so the divergence is visible
 * instead of silently claiming success.
 */
export async function handlePosPaymentVoided({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (!ENABLED) {
    logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping`);
    return;
  }

  const { payment_id } = event.data;
  if (!payment_id) {
    logger.warn(`${LOG_PREFIX} Missing payment_id in event data`);
    return;
  }

  logger.info(`${LOG_PREFIX} 📥 Processing void for payment ${payment_id}`);

  const financeService = container.resolve(FINANCE_MODULE) as any;

  // 1. Fetch the payment to get the QB TxnId
  const payment = await financeService.retrieveCustomerPayment(payment_id);
  if (!payment) {
    logger.error(`${LOG_PREFIX} Payment ${payment_id} not found`);
    return;
  }

  const orderId: string | undefined = payment.metadata?.order_id as
    | string
    | undefined;

  // Sales Receipt payments are embedded in a SR transaction — TxnVoid on the SR
  // is a separate operation not handled here.
  if (payment.metadata?.qb_source === "sales_receipt") {
    logger.info(
      `${LOG_PREFIX} ⏭️ Sales Receipt payment — void must be done on the SR itself, skipping standalone ReceivePayment void`
    );
    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voided" },
    });
    if (orderId) {
      await writePipelineRow({
        orderId,
        referenceId: payment_id,
        step: "payment",
        status: "confirmed",
      }).catch(() => {});
    }
    return;
  }

  const qbTxnId = payment.metadata?.qb_txn_id as string | undefined;

  if (!qbTxnId) {
    // Ojo: la ausencia de TxnID tiene DOS causas y sólo una es benigna.
    //
    //   (a) el pago nunca fue a QB (ej. un Dejavoo huérfano del
    //       CompleteOrderModal superado por un Sales Receipt) → cerrar la fila
    //       es correcto: no hay nada en QuickBooks.
    //   (b) su ReceivePaymentAdd está EN VUELO → el TxnID no existe TODAVÍA,
    //       pero el documento sí va a existir. Marcar la fila 'confirmed' acá
    //       es escribir una mentira: nada se voideó, y el ReceivePayment queda
    //       vivo en QB sin que nadie lo borre nunca.
    //
    // El void de pago es un TxnDel directo al bridge (QB rechaza TxnVoid sobre
    // ReceivePayment con 3110), no una fila de pipeline, así que no hay step de
    // void que materializar en el confirm. Hasta que exista, el caso (b) queda
    // VISIBLE como fila fallada en vez de silenciosamente "confirmado".
    let paymentInFlight: Array<{ id: string; step: string; status: string }> =
      [];
    try {
      paymentInFlight = await findInFlightQbRowsByRef(
        payment_id,
        "customer_payment",
        ["payment"]
      );
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not check in-flight payment rows: ${e.message}`
      );
    }

    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voided" },
    });

    if (paymentInFlight.length > 0) {
      // El ReceivePaymentAdd sigue en vuelo: el TxnDel todavía no tiene a qué
      // apuntar. NO se toca la fila del create — marcarla 'confirmed' sería
      // registrar un void que no ocurrió, y marcarla 'failed' rompería el
      // create, que va a terminar bien.
      //
      // La intención de void ya quedó persistida arriba
      // (`qb_sync_status='voided'` sin `qb_void_operation_id`), y
      // `enqueueVoidIfAlreadyVoided` la materializa como `void_payment` cuando
      // el ADD confirma — el primer instante con TxnID.
      const detail = paymentInFlight
        .map((r) => `${r.step}:${r.status}`)
        .join(", ");
      logger.info(
        `${LOG_PREFIX} ⏳ Void diferido — el create del pago ${payment_id} sigue en vuelo (${detail}); ` +
          `se emitirá el TxnDel al confirmar el ADD (ver pipeline/void-intent.ts)`
      );
      return;
    }

    logger.warn(
      `${LOG_PREFIX} Payment ${payment_id} has no qb_txn_id — marking voided locally only`
    );
    if (orderId) {
      await writePipelineRow({
        orderId,
        referenceId: payment_id,
        step: "payment",
        status: "confirmed",
      }).catch(() => {});
    }
    return;
  }

  // 2. Set sync status to voiding (shows spinner in UI)
  try {
    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voiding" },
    });
  } catch (mErr: any) {
    logger.warn(`${LOG_PREFIX} Could not set voiding status: ${mErr.message}`);
  }

  // 3. Call QB Bridge: TxnDel → ReceivePayment (QB rejects TxnVoid with 3110)
  logger.info(
    `${LOG_PREFIX} 🎯 Deleting ReceivePayment TxnID=${qbTxnId} in QuickBooks...`
  );
  try {
    const result = await bridgeFetch("POST", `/api/payments/${qbTxnId}/void`);

    if (!result?.success || !result?.operationId) {
      throw new Error(result?.error ?? "Bridge did not queue the delete");
    }

    logger.info(
      `${LOG_PREFIX} ⏳ Delete queued (op ${result.operationId}) — polling QB for confirmation...`
    );

    // CRITICAL: poll the actual QB result. pollRawOperationResult resolves only
    // when QB reports 'completed' and THROWS on failed/expired/timeout. Without
    // this, a QB-side rejection (e.g. Error 3110) left the payment marked
    // 'voided' in Medusa while it stayed alive in QB — a silent divergence.
    await pollRawOperationResult(
      result.operationId,
      (m) => logger.info(`${LOG_PREFIX} ${m}`)
    );

    logger.info(
      `${LOG_PREFIX} ✅ QB confirmed ReceivePayment ${qbTxnId} deleted.`
    );

    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: {
        ...(payment.metadata || {}),
        qb_sync_status: "voided",
        qb_void_operation_id: result.operationId,
      },
    });
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to delete payment in QB: ${err.message}`
    );
    try {
      await financeService.updateCustomerPayments({
        id: payment_id,
        metadata: {
          ...(payment.metadata || {}),
          qb_sync_status: "error",
          qb_void_error: String(err?.message ?? "unknown").slice(0, 300),
        },
      });
    } catch (_) {
      /* best effort */
    }
  }
}
