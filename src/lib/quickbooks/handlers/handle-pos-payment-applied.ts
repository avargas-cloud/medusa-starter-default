import { SubscriberArgs } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { FINANCE_MODULE } from "../../../modules/finance"
import { applyPaymentToInvoiceInQb, pollOperationResult } from "../qb-bridge-client"
import { getLatestInvoiceTxnId } from "../qb-metadata-types"

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

    const paymentTxnId = payment.metadata?.qb_txn_id as string
    if (!paymentTxnId) {
        logger.warn(`${LOG_PREFIX} Payment ${payment_id} has no qb_txn_id. Cannot apply it in QuickBooks.`)
        return
    }

    // 2. Fetch the order metadata to get the invoiceTxnId
    const { data: [order] } = await query.graph({
        entity: "order",
        fields: ["id", "metadata"],
        filters: { id: order_id }
    })

    if (!order || !order.metadata) {
        logger.warn(`${LOG_PREFIX} Order ${order_id} not found or missing metadata. Cannot find invoiceTxnId.`)
        return
    }

    let invoiceTxnId = getLatestInvoiceTxnId(order.metadata)

    // 3. Polling for up to 400 seconds if the Invoice hasn't finished syncing yet (20 attempts of 20 seconds)
    if (!invoiceTxnId) {
        logger.info(`${LOG_PREFIX} ⏳ Invoice TxnID not found immediately. Polling for up to 400 seconds to let Invoice Sync finish...`)
        for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 20000))
            const { data: [refreshedOrder] } = await query.graph({
                entity: "order",
                fields: ["metadata"],
                filters: { id: order_id }
            })
            invoiceTxnId = getLatestInvoiceTxnId(refreshedOrder?.metadata || {})
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
    logger.info(`${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${paymentTxnId}, Amount: $${(amount_applied/100).toFixed(2)}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`)
    
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
        amount: (amount_applied / 100),
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
