import { MedusaService } from "@medusajs/utils";

import { CustomerPayment } from "./models/customer-payment";
import { CustomerPaymentTransfer } from "./models/customer-payment-transfer";
import { PaymentApplication } from "./models/payment-application";
import { QbBankAccount } from "./models/qb-bank-account";

class FinanceModuleService extends MedusaService({
  CustomerPayment,
  CustomerPaymentTransfer,
  PaymentApplication,
  QbBankAccount,
}) {}

export default FinanceModuleService;
