import { MedusaContainer } from "@medusajs/framework/types"
import { INVOICE_MODULE } from "./src/modules/invoices"
import { FINANCE_MODULE } from "./src/modules/finance"

export default async function testBalance({ container }: { container: MedusaContainer }) {
    console.log("Initializing Medusa container via exec...")
    const invoiceService = container.resolve(INVOICE_MODULE)
    const financeService = container.resolve(FINANCE_MODULE)
    const customerId = 'cus_01JB65WNN23QYCWCRQXY02SMC8'

    const unappliedPayments = await financeService.listCustomerPayments({
        customer_id: customerId,
    }, {
        relations: ['applications']
    })
    console.log("Payments:", unappliedPayments.length)

    const allInvoices = await invoiceService.listPosInvoices({
        customer_id: customerId
    })
    console.log("Invoices:", allInvoices.length)

    console.log("Success!")
}
