import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import { FINANCE_MODULE } from "../../../modules/finance"
import { processPaymentCaptureInQb, ensureCustomerInQb } from "../order-flow-core"

const LOG_PREFIX = "[QB-POS-PAYMENT]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

export async function handlePosPaymentCreated({ event, container }: SubscriberArgs<any>) {
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
        const financeService = container.resolve(FINANCE_MODULE) as any
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

        // 4. Log intention based on deposit_type
        const depositType = payment.metadata?.deposit_type
        if (depositType === 'INVOICE') {
            logger.info(`${LOG_PREFIX} ℹ️ Payment is for an INVOICE. The unapplied credit was created successfully. Application to the Invoice will be handled by pos.payment.applied.`)
        } else if (depositType === 'ORDER') {
            logger.info(`${LOG_PREFIX} ℹ️ Payment is for an ORDER. It will sit as unapplied credit until the final Standalone Invoice or Linked Invoice applies it.`)
        }

    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Unhandled exception: ${err.message}`)
        logger.error(err.stack)
    }
}

