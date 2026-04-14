import { MedusaService } from "@medusajs/utils";
import { CustomerPayment } from "./models/customer-payment";
import { PaymentApplication } from "./models/payment-application";
import { QbBankAccount } from "./models/qb-bank-account";

class FinanceModuleService extends MedusaService({
  CustomerPayment,
  PaymentApplication,
  QbBankAccount,
}) {}

export default FinanceModuleService;
