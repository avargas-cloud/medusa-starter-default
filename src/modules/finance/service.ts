import { MedusaService } from "@medusajs/utils"
import { CustomerPayment } from './models/customer-payment'
import { PaymentApplication } from './models/payment-application'

class FinanceModuleService extends MedusaService({
    CustomerPayment,
    PaymentApplication,
}) {}

export default FinanceModuleService
