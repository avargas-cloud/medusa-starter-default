import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getCustomerInvoice } from "../../../../../../lib/storefront/customer-documents";

/**
 * GET /store/customers/me/invoices/:id
 * 404 (not 403) when the invoice doesn't exist or isn't owned by the
 * requesting customer — don't confirm existence of another customer's doc.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = (req as any).auth_context?.actor_id;
  if (!customerId) {
    res.status(401).json({ message: "Unauthorized. No customer ID found." });
    return;
  }

  try {
    const invoiceId = req.params.id as string;
    const invoice = await getCustomerInvoice(req.scope, customerId, invoiceId);

    if (!invoice) {
      res.status(404).json({ message: "Invoice not found" });
      return;
    }

    res.json({ invoice });
  } catch (err) {
    const logger = req.scope.resolve("logger") as any;
    logger.error(
      `[store/customers/me/invoices/:id] failed to load invoice: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    res.status(500).json({ message: "Failed to load invoice" });
  }
}
