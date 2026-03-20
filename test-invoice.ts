import { MedusaModule } from "@medusajs/modules-sdk"
import { INVOICE_MODULE } from "./src/modules/invoices"
import InvoiceModuleService from "./src/modules/invoices/service"

async function run() {
    const invoiceService = await MedusaModule.bootstrap<InvoiceModuleService>({
        moduleKey: INVOICE_MODULE,
        defaultPath: __dirname + "/src/modules/invoices"
    })
    
    const all = await invoiceService.listPosInvoices({ invoice_number: 'INV-1155-1' })
    console.log(JSON.stringify(all, null, 2))
    process.exit(0)
}
run().catch(console.error)
