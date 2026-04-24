/**
 * POST /admin/customer-payments/:id/mark-terminal-refunded
 *
 * Merges terminal_refunded=true + audit fields into the payment's metadata.
 * Called by the store-pos refund API route after a successful processor return.
 * Idempotent — safe to call multiple times.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { FINANCE_MODULE } from "../../../../../modules/finance"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!
  const { terminal_refund_transaction_id } = req.body as {
    terminal_refund_transaction_id?: string
  }

  const financeService = req.scope.resolve(FINANCE_MODULE)

  try {
    const payment = await financeService.retrieveCustomerPayment(id)
    if (!payment) return res.status(404).json({ error: "Payment not found" })

    const meta = (payment.metadata as Record<string, unknown>) ?? {}

    await financeService.updateCustomerPayments({
      id,
      metadata: {
        ...meta,
        terminal_refunded: true,
        terminal_refund_transaction_id: terminal_refund_transaction_id ?? null,
        terminal_refunded_at: new Date().toISOString(),
      },
    })

    return res.json({ success: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ error: msg })
  }
}
