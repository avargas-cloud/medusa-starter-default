import { MedusaContainer } from "@medusajs/framework/types"
import { INVOICE_MODULE } from "./src/modules/invoices"
import { FINANCE_MODULE } from "./src/modules/finance"

export default async function migrateOldPayments({ container }: { container: MedusaContainer }) {
    console.log("Initializing Medusa container via exec...")
    const invoiceService = container.resolve(INVOICE_MODULE)
    const financeService = container.resolve(FINANCE_MODULE)

    // 1. Fetch all Invoices to have a map of invoice_id -> order_id and customer_id
    console.log("Fetching invoices...")
    const invoices = await invoiceService.listPosInvoices({}, { take: 10000 })
    console.log(`Found ${invoices.length} invoices.`)
    
    // 2. Fetch all existing PaymentApplications to see which ones are already migrated
    console.log("Fetching existing payment applications...")
    const existingApps = await financeService.listPaymentApplications({}, { take: 10000 })
    console.log(`Found ${existingApps.length} existing apps.`)

    let totalMigrated = 0;

    for (const inv of invoices) {
        if (!inv.customer_id) continue;
        
        const invPayments = await invoiceService.listInvoicePayments({ invoice_id: inv.id }, { take: 100 })
        if (!invPayments || invPayments.length === 0) {
            console.log(`Invoice ${inv.id} has no payments.`)
            continue;
        }

        const customer_id = inv.customer_id as string
        const order_id = inv.order_id as string

        // Find existing apps for this invoice
        const appsForInvoice = existingApps.filter((app: any) => app.invoice_id === inv.id)
        
        if (appsForInvoice.length >= invPayments.length) {
            // Already migrated
            continue;
        }

        console.log(`Invoice ${inv.id} has ${invPayments.length} payments, but only ${appsForInvoice.length} applications. Migrating missing...`)

        let poolOfApps = [...appsForInvoice]

        for (const payment of invPayments) {
            // Check if there is an app in the pool that matches the amount
            const matchIndex = poolOfApps.findIndex(a => Number(a.amount_applied) === Number(payment.amount))
            if (matchIndex >= 0) {
                // Remove from pool, it's already accounted for
                poolOfApps.splice(matchIndex, 1)
                continue;
            }

            // It's an orphan payment! We must migrate it
            console.log(` -> Migrating payment of ${payment.amount} for invoice ${inv.id} (Paid at: ${payment.paid_at})`)
            
            // 1. Create CustomerPayment
            const customerPayment = await financeService.createCustomerPayments({
                customer_id,
                amount: payment.amount,
                method: (payment.payment_method as any) || 'other',
                reference: `Migrated from INVPAY-${payment.id.substring(payment.id.length - 6)}`,
                notes: payment.notes || 'Migrated old invoice payment',
                received_at: payment.paid_at || payment.created_at,
                created_by: payment.created_by || null,
                source: 'pos',
                type: 'payment',
                status: 'applied',
            })

            // 2. Create PaymentApplication
            await financeService.createPaymentApplications({
                payment_id: customerPayment.id,
                invoice_id: inv.id,
                order_id: order_id,
                amount_applied: payment.amount,
                applied_at: payment.paid_at || payment.created_at,
                applied_by: payment.created_by || null
            })
            
            totalMigrated++;
        }
    }

    console.log(`Migration complete. Generated ${totalMigrated} CustomerPayments/Applications.`)
}
