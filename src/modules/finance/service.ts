import type { Context } from "@medusajs/types";
import { MedusaService } from "@medusajs/utils";

import { computeBatchDay, getBatchCutoff } from "../../lib/finance/batch-day";
import { CustomerPayment } from "./models/customer-payment";
import { CustomerPaymentTransfer } from "./models/customer-payment-transfer";
import { PaymentApplication } from "./models/payment-application";
import { QbBankAccount } from "./models/qb-bank-account";

type CustomerPaymentCreateInput = Record<string, unknown> & {
  received_at?: string | Date | null;
  batch_day?: string | null;
};

const Base = MedusaService({
  CustomerPayment,
  CustomerPaymentTransfer,
  PaymentApplication,
  QbBankAccount,
});

class FinanceModuleService extends Base {
  /**
   * Central batch_day default — every customer_payment insert (routes,
   * subscribers, scripts) flows through the module service, so the merchant
   * batch day is filled in ONE place. An explicit batch_day in the input is
   * respected (e.g. QB import paths); otherwise it derives from received_at
   * (or now) using the store's batch cutoff (after 18:45 ET → next day).
   *
   * Signature mirrors the generated method (single object or array in,
   * matching shape out); sharedContext is forwarded untouched so
   * transaction/manager semantics are preserved.
   */
  // @ts-expect-error — narrows the generated overloads to a single compatible implementation
  override async createCustomerPayments(
    input: CustomerPaymentCreateInput | CustomerPaymentCreateInput[],
    sharedContext?: Context
  ) {
    const cutoff = await getBatchCutoff();

    const withBatchDay = (
      item: CustomerPaymentCreateInput
    ): CustomerPaymentCreateInput =>
      item.batch_day
        ? item
        : { ...item, batch_day: computeBatchDay(item.received_at, cutoff) };

    const enriched = Array.isArray(input)
      ? input.map(withBatchDay)
      : withBatchDay(input);

    return await super.createCustomerPayments(
      enriched as never,
      sharedContext
    );
  }
}

export default FinanceModuleService;
