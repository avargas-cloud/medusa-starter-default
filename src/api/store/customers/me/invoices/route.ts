import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { listCustomerInvoices } from "../../../../../lib/storefront/customer-documents";

/**
 * GET /store/customers/me/invoices
 *
 * Query params: order_id (optional), limit (max 50, default 20), offset.
 * These are custom params on a custom route — no Medusa list-param validator
 * is registered for /store/customers/me/* in middlewares.ts, so unknown
 * query keys are simply ignored rather than rejected.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = (req as any).auth_context?.actor_id;
  if (!customerId) {
    res.status(401).json({ message: "Unauthorized. No customer ID found." });
    return;
  }

  try {
    const { order_id, q, limit, offset } = req.query as Record<string, string>;

    const { invoices, count } = await listCustomerInvoices(
      req.scope,
      customerId,
      {
        orderId: order_id || undefined,
        q: typeof q === "string" ? q.slice(0, 40) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      }
    );

    res.json({ invoices, count });
  } catch (err) {
    const logger = req.scope.resolve("logger") as any;
    logger.error(
      `[store/customers/me/invoices] failed to list invoices: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    res.status(500).json({ message: "Failed to load invoices" });
  }
}
