/**
 * src/modules/invoices/service.ts
 * Invoice module service — delegates CRUD to MedusaService framework methods.
 * Business logic (invoice number generation, void checks) is handled in API routes.
 */

import { MedusaService } from "@medusajs/utils";

import { InvoicePayment } from "./models/invoice-payment";
import InvoiceTracking from "./models/invoice-tracking";
import PosInvoice from "./models/pos-invoice";
import PosInvoiceItem from "./models/pos-invoice-item";

class InvoiceModuleService extends MedusaService({
  PosInvoice,
  PosInvoiceItem,
  InvoiceTracking,
  InvoicePayment,
}) {}

export default InvoiceModuleService;
