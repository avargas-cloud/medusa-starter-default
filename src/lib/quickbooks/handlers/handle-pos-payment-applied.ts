import { SubscriberArgs } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { FINANCE_MODULE } from "../../../modules/finance"
import { applyPaymentToInvoiceInQb, pollOperationResult } from "../qb-bridge-client"

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

    let paymentTxnId = payment.metadata?.qb_txn_id as string | undefined

    // Wait for the payment to finish syncing to QB if it hasn't yet (up to 400 seconds)
    if (!paymentTxnId) {
        logger.info(`${LOG_PREFIX} ⏳ Payment TxnID not found immediately. Polling for up to 400 seconds to let Payment Sync finish...`)
        for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 20000))
            const refreshedPayment = await financeService.retrieveCustomerPayment(payment_id).catch(() => null)
            paymentTxnId = refreshedPayment?.metadata?.qb_txn_id as string | undefined
            if (paymentTxnId) {
                logger.info(`${LOG_PREFIX} ⏳ Found paymentTxnId: ${paymentTxnId} on attempt ${i + 1}`)
                break
            }
        }
    }

    if (!paymentTxnId) {
        logger.warn(`${LOG_PREFIX} Payment ${payment_id} still has no qb_txn_id after polling. Cannot apply it in QuickBooks.`)
        return
    }

    // 2. Fetch the Invoice metadata to get the qb_txn_id
    let { data: [invoice] } = await query.graph({
        entity: "pos_invoice",
        fields: ["id", "metadata"],
        filters: { id: invoice_id }
    })

    if (!invoice) {
        logger.warn(`${LOG_PREFIX} Invoice ${invoice_id} not found. Cannot apply payment.`)
        return
    }

    let invoiceTxnId = invoice.metadata?.qb_txn_id as string | undefined

    // 3. Polling for up to 100 seconds if the Invoice hasn't finished syncing yet (10 attempts of 10 seconds)
    if (!invoiceTxnId) {
        logger.info(`${LOG_PREFIX} ⏳ Invoice TxnID not found immediately. Polling for up to 100 seconds to let Invoice Sync finish...`)
        for (let i = 0; i < 10; i++) {
            await new Promise(res => setTimeout(res, 10000))
            const { data: [refreshedInvoice] } = await query.graph({
                entity: "pos_invoice",
                fields: ["metadata"],
                filters: { id: invoice_id }
            })
            invoiceTxnId = refreshedInvoice?.metadata?.qb_txn_id as string | undefined
            if (invoiceTxnId) {
                logger.info(`${LOG_PREFIX} ⏳ Found invoiceTxnId: ${invoiceTxnId} on attempt ${i + 1}`)
                break
            }
        }
    }

    if (!invoiceTxnId) {
        logger.error(`${LOG_PREFIX} ❌ Timed out waiting for Invoice TxnID on order ${order_id}. Cannot apply payment ${paymentTxnId}.`)
        return
    }

    // 4. Fire the Bridge Request to Apply Payment to Invoice!
    logger.info(`${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${paymentTxnId}, Amount: $${amount_applied.toFixed(2)}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`)
    
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

    const applyResult = await applyPaymentToInvoiceInQb({
        customerId: customerQbId,
        invoiceId: invoiceTxnId,
        amount: amount_applied / 100,
        creditTxnId: paymentTxnId
    })

    if (!applyResult.success) {
        logger.error(`${LOG_PREFIX} ❌ Failed to apply payment in QB: ${applyResult.error}`)
    } else {
        const opId = applyResult.data?.operationId
        if (opId && opId !== "DRY_RUN") {
            logger.info(`${LOG_PREFIX} ✅ Application request queued. OperationID: ${opId}`)
            try {
                const finalResult = await pollOperationResult(opId, (m: string) => logger.info(m))
                
                if (finalResult && finalResult.txnId) {
                    logger.info(`${LOG_PREFIX} ✅ Successfully applied payment to invoice in QB! TxnID: ${finalResult.txnId}`)
                } else {
                    logger.warn(`${LOG_PREFIX} ⚠️ Polling completed but no TxnID returned by WebConnector.`)
                }
            } catch (pollErr: any) {
                logger.error(`${LOG_PREFIX} ❌ QB Application Failed during polling: ${pollErr.message}`)
            }
        } else {
            logger.info(`${LOG_PREFIX} ✅ Dry-run or instant success reported.`)
        }
    }
}
