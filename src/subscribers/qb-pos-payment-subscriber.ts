import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import { FINANCE_MODULE } from "../modules/finance"
import { processPaymentCaptureInQb, ensureCustomerInQb } from "../lib/quickbooks/order-flow-core"
import { applyPaymentToInvoiceInQb } from "../lib/quickbooks/qb-bridge-client"
import { getLatestInvoiceTxnId } from "../lib/quickbooks/qb-metadata-types"

const LOG_PREFIX = "[QB-POS-PAYMENT]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

export default async function qbPosPaymentSubscriber({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    if (!ENABLED) {
        logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`)
        return
    }

    const paymentId = event.data.id
    if (!paymentId) return

    logger.info(`${LOG_PREFIX} 📥 Received ${event.name} for payment ${paymentId}`)

    try {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const financeService = container.resolve(FINANCE_MODULE)
        const customerModule = container.resolve(Modules.CUSTOMER)

        // 1. Fetch the Payment
        const { data: [payment] } = await query.graph({
            entity: "customer_payment",
            fields: ["*", "metadata"],
            filters: { id: paymentId }
        })

        if (!payment) {
            logger.warn(`${LOG_PREFIX} ⚠️ Payment not found: ${paymentId}`)
            return
        }

        // Only process POS generated ones (exclude ACH synced from QBO if we ever add that)
        if (payment.source !== "pos") {
            logger.info(`${LOG_PREFIX} Skipping non-POS payment: ${payment.source}`)
            return
        }

        const orderId = payment.metadata?.order_id
        const orderDisplayId = payment.metadata?.order_display_id

        if (!orderId) {
            logger.warn(`${LOG_PREFIX} ⚠️ Payment ${paymentId} has no order_id in metadata, cannot map to QB completely.`)
        }

        // 2. Resolve Customer List ID
        let customer = null
        let qbCustomerId = null

        if (payment.customer_id) {
            customer = await customerModule.retrieveCustomer(payment.customer_id, {
                relations: ["addresses"]
            })
            qbCustomerId = customer.metadata?.qb_list_id
        }

        if (!qbCustomerId && customer) {
            logger.info(`${LOG_PREFIX} Customer ${customer.id} not in QB yet. Ensuring...`)
            const custResult = await ensureCustomerInQb(customer, customerModule, (msg) => logger.info(msg))
            if (custResult.success) {
                qbCustomerId = custResult.qbCustomerId
            } else {
                logger.error(`${LOG_PREFIX} ❌ Failed to ensure customer in QB: ${custResult.error}`)
                return
            }
        }

        if (!qbCustomerId) {
            logger.error(`${LOG_PREFIX} ❌ Could not determine qb_list_id for payment ${paymentId}`)
            return
        }

        // 3. Register Payment as ReceivePayment in QuickBooks
        // This drops the deposit into QB as an unapplied credit (linked to the correct Customer)
        const result = await processPaymentCaptureInQb({
            orderId: (orderId as string) || `payment_${paymentId}`,
            orderDisplayId: (orderDisplayId as number) || undefined,
            amount: payment.amount as number, // already cents
            paymentMethod: (payment.metadata?.pos_payment_method as string) || (payment.method as string),
            qbCustomerId: qbCustomerId as string
        })

        if (result.skipped) {
            logger.info(`${LOG_PREFIX} ⏭️ Skipped: QB disabled or not configured`)
            return
        }
        if (result.error) {
            logger.error(`${LOG_PREFIX} ❌ QB Payment Capture failed: ${result.error}`)
            return
        }

        // Save QB TxnId to the POS Payment record
        if (result.txnId || result.operationId) {
            try {
                await financeService.updateCustomerPayments({
                    id: paymentId,
                    metadata: {
                        ...(payment.metadata || {}),
                        qb_txn_id: result.txnId || null,
                        qb_operation_id: result.operationId || null,
                    }
                })
                logger.info(`${LOG_PREFIX} ✅ Saved QB TxnID=${result.txnId} to POS payment ${paymentId}`)
            } catch (err: any) {
                logger.warn(`${LOG_PREFIX} ⚠️ Failed to save QB TxnID to payment ${paymentId}: ${err.message}`)
            }
        }

        // 4. Auto-Apply to QB Invoice if deposit_type === 'INVOICE'
        const depositType = payment.metadata?.deposit_type
        if (depositType === 'INVOICE' && orderId && result.txnId) {
            logger.info(`${LOG_PREFIX} 🔄 Payment is for an INVOICE. Checking if QB Invoice exists for order ${orderId}...`)
            
            // Query the order to get its QB metadata
            const { data: [order] } = await query.graph({
                entity: "order",
                fields: ["id", "metadata"],
                filters: { id: orderId }
            })

            if (order && order.metadata) {
                const invoiceTxnId = getLatestInvoiceTxnId(order.metadata)
                
                if (invoiceTxnId) {
                    logger.info(`${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${result.txnId}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`)
                    const applyResult = await applyPaymentToInvoiceInQb({
                        customerId: qbCustomerId as string,
                        amount: (payment.amount as number) / 100, // dollars
                        invoiceId: invoiceTxnId,
                        creditTxnId: result.txnId
                    })

                    if (!applyResult.success) {
                        logger.error(`${LOG_PREFIX} ⚠️ Failed to apply payment to invoice in QB: ${applyResult.error}`)
                    } else {
                        logger.info(`${LOG_PREFIX} ✅ Successfully applied Payment to Invoice in QuickBooks!`)
                    }
                } else {
                    logger.warn(`${LOG_PREFIX} ⚠️ order ${orderId} does not have a qb_invoice_txn_id yet. Payment will remain unapplied in QB until manually matched.`)
                }
            }
        } else if (depositType === 'ORDER') {
            logger.info(`${LOG_PREFIX} ℹ️ Payment is for an ORDER. It will sit as unapplied credit until the final Standalone Invoice or Linked Invoice applies it.`)
        }

    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Unhandled exception: ${err.message}`)
        logger.error(err.stack)
    }
}

export const config: SubscriberConfig = {
    event: "pos.payment.created",
    context: {
        subscriberId: "qb-pos-payment-subscriber",
    },
}
