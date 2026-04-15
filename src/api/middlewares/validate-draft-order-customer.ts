/**
 * Guard for POST /admin/draft-orders.
 *
 * Rejects any draft-order creation where `customer_id` is missing or
 * doesn't resolve to a live customer in DB. The POS frontend deliberately
 * omits `email` from the payload to prevent Medusa v2's
 * findOrCreateCustomerStep from silently creating zombie customers (or
 * swapping to a sibling with the same email on a different casing) — which
 * means `customer_id` MUST be valid or the save should fail loudly.
 *
 * This middleware runs before Medusa's createOrderWorkflow so the error
 * surfaces as a clean 400 with a code the POS client can handle instead of
 * a cryptic workflow crash from deep inside core-flows.
 */

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"

export async function validateDraftOrderCustomer(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = (req.body ?? {}) as Record<string, unknown>
  const customerId =
    typeof body.customer_id === "string" && body.customer_id.length > 0
      ? body.customer_id
      : null

  if (!customerId) {
    return res.status(400).json({
      error:
        "customer_id is required. Please select a customer before saving.",
      code: "CUSTOMER_REQUIRED",
    })
  }

  try {
    const customerModule = req.scope.resolve(Modules.CUSTOMER)
    const customer = await customerModule
      .retrieveCustomer(customerId)
      .catch(() => null)

    if (!customer) {
      return res.status(400).json({
        error:
          "The selected customer no longer exists. Reload the POS (F5) and reselect a customer.",
        code: "CUSTOMER_NOT_FOUND",
        customer_id: customerId,
      })
    }

    return next()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `[validateDraftOrderCustomer] unexpected error for customer_id=${customerId}:`,
      message
    )
    return res.status(500).json({
      error: "Failed to validate customer. Try again.",
      code: "VALIDATE_CUSTOMER_ERROR",
    })
  }
}
