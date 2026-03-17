import { MedusaContainer } from "@medusajs/framework/types"
import { FINANCE_MODULE } from "./src/modules/finance"

export default async function syncWebPayments({ container }: { container: MedusaContainer }) {
    console.log("Initializing Medusa container via exec...")
    const financeService = container.resolve(FINANCE_MODULE)
    const query = container.resolve("query")

    // We pull all orders with their payments
    const { data: orders } = await query.graph({
        entity: "order",
        fields: [
            "id", 
            "customer_id",
            "payment_collections.*",
            "payment_collections.payments.*"
        ],
    })

    console.log(`Found ${orders.length} orders. Extracting payments...`)

    let totalSynced = 0;

    for (const order of orders) {
        if (!order.customer_id) continue;
        if (!order.payment_collections || order.payment_collections.length === 0) continue;

        for (const pc of order.payment_collections) {
            if (!pc || !pc.payments || pc.payments.length === 0) continue;

            for (const payment of pc.payments) {
                if (!payment) continue;
                // Focus only on captured payments
                if (!payment.captured_at) continue;

                const medusaPaymentId = payment.id as string
                const amountToRecord = payment.amount as number

                // Check Idempotency
                const existingRecords = await financeService.listCustomerPayments({
                    medusa_payment_id: medusaPaymentId
                })

                if (existingRecords && existingRecords.length > 0) {
                    continue; // Already processed
                }

                console.log(` -> Found missing CAPTURED web payment ${medusaPaymentId} for Order ${order.id}. Syncing...`)

                // Create the mirror record
                await financeService.createCustomerPayments({
                    customer_id: order.customer_id as string,
                    amount: amountToRecord,
                    method: payment.provider_id?.includes('authorize') ? 'authorize_net' : (payment.provider_id?.includes('stripe') ? 'stripe' : 'card'),
                    reference: payment.provider_id || null, 
                    received_at: payment.captured_at ? new Date(payment.captured_at as string) : new Date(),
                    created_by: 'system_sync',
                    source: 'web',
                    type: 'payment',
                    status: 'available', // Web payments are immediately available
                    medusa_payment_id: medusaPaymentId,
                    locked_order_id: order.id
                })

                totalSynced++;
            }
        }
    }

    console.log(`Web Payment Sync Complete. Generated ${totalSynced} CustomerPayments/Applications.`)
}
