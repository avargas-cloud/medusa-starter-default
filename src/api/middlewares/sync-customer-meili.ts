import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { updateSingleCustomerWorkflow } from "../../workflows/update-single-customer";

/**
 * Fires updateSingleCustomerWorkflow after a successful PATCH on a customer.
 * Runs post-response so it never blocks the API caller.
 */
export function syncCustomerMeili(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const customerId = (req.params as Record<string, string>).id;

  res.on("finish", () => {
    if (!customerId || res.statusCode < 200 || res.statusCode >= 300) return;

    updateSingleCustomerWorkflow(req.scope)
      .run({ input: { customerId } })
      .catch((err: Error) => {
        const logger = req.scope.resolve<{ error: (msg: string, e: Error) => void }>("logger");
        logger.error("[MEILI-CUSTOMER-SYNC] post-PATCH sync failed:", err);
      });
  });

  next();
}
