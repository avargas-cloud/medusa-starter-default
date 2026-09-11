/**
 * src/modules/bill-payments/service.ts
 *
 * Thin — delegates CRUD to MedusaService framework methods. Every write that
 * carries an invariant (Σ allocations = amount, allocation ≤ bill balance,
 * period lock, vendor match) goes through `src/lib/bill-payments/**` over a
 * raw pg client with `SELECT … FOR UPDATE`, never through this service.
 */
import { MedusaService } from "@medusajs/utils";

import { VendorBillPayment } from "./models/vendor-bill-payment";
import { VendorBillPaymentAllocation } from "./models/vendor-bill-payment-allocation";

class BillPaymentsModuleService extends MedusaService({
  VendorBillPayment,
  VendorBillPaymentAllocation,
}) {}

export default BillPaymentsModuleService;
