import { SubscriberArgs } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { FINANCE_MODULE } from "../../../modules/finance"
import { applyPaymentToInvoiceInQb, pollOperationResult } from "../qb-bridge-client"
import { writePipelineRow, getCachedEditSequence } from "../qb-pipeline"

const LOG_PREFIX = "[QB-POS-PAYMENT-APPLIED]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

export async function handlePosPaymentApplied({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    if (!ENABLED) {
        logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`)
        return
    }

    const { payment_id, invoice_id, order_id, amount_applied } = event.data
    if (!payment_id || !invoice_id || !order_id) {
        logger.warn(`${LOG_PREFIX} Missing required fields in event data: ${JSON.stringify(event.data)}`)
        return
    }

    logger.info(`${LOG_PREFIX} 📥 Received ${event.name} for payment ${payment_id} -> invoice ${invoice_id}`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const financeService = container.resolve(FINANCE_MODULE)

    // 1. Fetch the payment to get the QB TxnId
    const payment = await financeService.retrieveCustomerPayment(payment_id)
    if (!payment) {
        logger.error(`${LOG_PREFIX} Payment ${payment_id} not found in DB!`)
        return
    }

    // SALES RECEIPT GUARD: payments embedded in a QB Sales Receipt cannot be applied
    // to an invoice separately — the SR already captures the full transaction.
    if (payment.metadata?.qb_source === 'sales_receipt') {
        logger.info(`${LOG_PREFIX} ⏭️ Skipping apply: payment ${payment_id} was captured in a Sales Receipt — apply/unapply not supported in QB for SR payments`)
        return
    }

    let paymentTxnId = payment.metadata?.qb_txn_id as string | undefined
    // Declare here so it's available in all early-exit error paths below
    const medusaPayRef = (payment as any).display_id ? `PAY-${(payment as any).display_id}` : null

    // Wait for the payment to finish syncing to QB if it hasn't yet (up to 400 seconds)
    if (!paymentTxnId) {
        logger.info(`${LOG_PREFIX} ⏳ Payment TxnID not found immediately. Polling for up to 400 seconds to let Payment Sync finish...`)
        for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 20000))
            const refreshedPayment = await financeService.retrieveCustomerPayment(payment_id).catch(() => null)
            paymentTxnId = refreshedPayment?.metadata?.qb_txn_id as string | undefined
            const currentStatus = refreshedPayment?.metadata?.qb_sync_status

            if (paymentTxnId) {
                logger.info(`${LOG_PREFIX} ⏳ Found paymentTxnId: ${paymentTxnId} on attempt ${i + 1}`)
                break
            }
            if (currentStatus === "error") {
                logger.error(`${LOG_PREFIX} ❌ Payment sync failed with status 'error'. Aborting application logic.`)
                break
            }
        }
    }

    if (!paymentTxnId) {
        logger.warn(`${LOG_PREFIX} Payment ${payment_id} still has no qb_txn_id after polling. Cannot apply it in QuickBooks.`)
        try {
            await writePipelineRow({
                orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                step: "apply_payment", status: "failed",
                medusaRefNumber: medusaPayRef,
                error: "Payment not yet synced to QB — retry after payment is confirmed",
            })
        } catch {}
        return
    }

    // 2. Fetch the Invoice metadata to get the qb_txn_id
    let { data: [invoice] } = await query.graph({
        entity: "pos_invoice",
        fields: ["id", "invoice_number", "metadata"],
        filters: { id: invoice_id }
    })

    if (!invoice) {
        logger.warn(`${LOG_PREFIX} Invoice ${invoice_id} not found. Cannot apply payment.`)
        return
    }

    let invoiceTxnId = invoice.metadata?.qb_txn_id as string | undefined
    let invoiceNumber = (invoice as any).invoice_number as string | undefined

    // 3. Polling for up to 100 seconds if the Invoice hasn't finished syncing yet (10 attempts of 10 seconds)
    if (!invoiceTxnId) {
        logger.info(`${LOG_PREFIX} ⏳ Invoice TxnID not found immediately. Polling for up to 100 seconds to let Invoice Sync finish...`)
        for (let i = 0; i < 10; i++) {
            await new Promise(res => setTimeout(res, 10000))
            const { data: [refreshedInvoice] } = await query.graph({
                entity: "pos_invoice",
                fields: ["invoice_number", "metadata"],
                filters: { id: invoice_id }
            })
            invoiceTxnId = refreshedInvoice?.metadata?.qb_txn_id as string | undefined
            const currentInvStatus = refreshedInvoice?.metadata?.qb_sync_status
            if (refreshedInvoice?.invoice_number) invoiceNumber = refreshedInvoice.invoice_number as string

            if (invoiceTxnId) {
                logger.info(`${LOG_PREFIX} ⏳ Found invoiceTxnId: ${invoiceTxnId} on attempt ${i + 1}`)
                break
            }
            if (currentInvStatus === "error") {
                logger.error(`${LOG_PREFIX} ❌ Invoice sync failed with status 'error'. Aborting application logic.`)
                break
            }
        }
    }

    if (!invoiceTxnId) {
        logger.error(`${LOG_PREFIX} ❌ Timed out waiting for Invoice TxnID on order ${order_id}. Cannot apply payment ${paymentTxnId}.`)
        return
    }

    // 4. Write pre-flight pipeline row
    try {
        await writePipelineRow({
            orderId:       order_id,
            referenceId:   payment_id,
            referenceType: "customer_payment",
            step:          "apply_payment",
            status:        "pending",
            medusaRefNumber: medusaPayRef,
        })
    } catch (pErr: any) {
        logger.warn(`${LOG_PREFIX} Could not write pre-flight pipeline row: ${pErr.message}`)
    }

    // 5. Fire the Bridge Request to Apply Payment to Invoice!
    logger.info(`${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${paymentTxnId}, Amount: $${(amount_applied / 100).toFixed(2)}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`)

    // Fetch the customer based on the order to get QB List ID if needed
    // (applyPaymentToInvoiceInQb needs customerId)
    const { data: [customer] } = await query.graph({
        entity: "customer",
        fields: ["id", "metadata"],
        filters: { id: payment.customer_id }
    })

    const customerQbId = customer?.metadata?.qb_list_id as string | undefined

    if (!customerQbId) {
        logger.error(`${LOG_PREFIX} ❌ Customer ${payment.customer_id} has no qb_list_id. Cannot apply payment.`)
        return
    }

    // Get the EditSequence from cache (saved when the payment was created in QB).
    // Without this, the bridge would create a new duplicate payment record instead of
    // modifying the existing one.
    const editSequence = (await getCachedEditSequence("payment", paymentTxnId).catch(() => null))?.editSeq ?? null
    if (!editSequence) {
        logger.error(`${LOG_PREFIX} ❌ No EditSequence found in cache for payment TxnID=${paymentTxnId}. Cannot apply via ReceivePaymentMod.`)
        try {
            await writePipelineRow({
                orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                step: "apply_payment", status: "failed",
                medusaRefNumber: medusaPayRef,
                error: "EditSequence not cached — payment was created before caching was introduced, or cache expired",
            })
        } catch {}
        return
    }
    logger.info(`${LOG_PREFIX} 🔑 EditSequence resolved for TxnID=${paymentTxnId}`)

    // Build updated memo: replace the original "for Order X" with "for Invoice Y"
    // so the QB payment reflects its final use instead of the original deposit context.
    const payDisplayId = (payment as any).display_id
    const updatedMemo = invoiceNumber
        ? (payDisplayId ? `Payment ${payDisplayId} for Invoice ${invoiceNumber}` : `Payment for Invoice ${invoiceNumber}`)
        : undefined

    const applyResult = await applyPaymentToInvoiceInQb({
        customerId: customerQbId,
        invoiceId: invoiceTxnId,
        amount: amount_applied / 100,
        creditTxnId: paymentTxnId,
        editSequence,
        memo: updatedMemo,
    })

    if (!applyResult.success) {
        logger.error(`${LOG_PREFIX} ❌ Failed to apply payment in QB: ${applyResult.error}`)
        try {
            await writePipelineRow({
                orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                step: "apply_payment", status: "failed",
                medusaRefNumber: medusaPayRef, error: applyResult.error || "Apply failed",
            })
        } catch {}
    } else {
        const opId = applyResult.data?.operationId
        if (opId && opId !== "DRY_RUN") {
            logger.info(`${LOG_PREFIX} ✅ Application request queued. OperationID: ${opId}`)
            try {
                await writePipelineRow({
                    orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                    step: "apply_payment", status: "submitted",
                    medusaRefNumber: medusaPayRef, bridgeOpId: opId,
                })
            } catch {}
            try {
                const finalResult = await pollOperationResult(opId, (m: string) => logger.info(m))
                if (finalResult && finalResult.txnId) {
                    logger.info(`${LOG_PREFIX} ✅ Successfully applied payment to invoice in QB! TxnID: ${finalResult.txnId}`)
                    await writePipelineRow({
                        orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                        step: "apply_payment", status: "confirmed",
                        medusaRefNumber: medusaPayRef, bridgeOpId: opId, qbTxnId: finalResult.txnId,
                    }).catch(() => {})
                } else {
                    logger.warn(`${LOG_PREFIX} ⚠️ Polling completed but no TxnID returned by WebConnector.`)
                }
            } catch (pollErr: any) {
                logger.error(`${LOG_PREFIX} ❌ QB Application Failed during polling: ${pollErr.message}`)
            }
        } else {
            logger.info(`${LOG_PREFIX} ✅ Dry-run or instant success reported.`)
            try {
                await writePipelineRow({
                    orderId: order_id, referenceId: payment_id, referenceType: "customer_payment",
                    step: "apply_payment", status: "confirmed",
                    medusaRefNumber: medusaPayRef,
                })
            } catch {}
        }
    }
}
