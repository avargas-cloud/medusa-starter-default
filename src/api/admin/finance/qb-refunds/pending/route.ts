import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { FINANCE_MODULE } from "../../../../../modules/finance"
import { Modules } from "@medusajs/utils"

/**
 * GET /admin/finance/qb-refunds/pending
 *
 * Returns CustomerPayments of type='refund' that have not yet been synced to QB
 * (qb is null OR qb.status !== 'yes').
 * Enriched with customer name for display in the accounting page.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const financeService = req.scope.resolve(FINANCE_MODULE)
  const customerModule = req.scope.resolve(Modules.CUSTOMER)

  const allRefunds = await financeService.listCustomerPayments(
    { type: "refund" } as any,
    { order: { received_at: "DESC" } }
  )

  // Show all refunds — confirmed ones stay visible with "Confirmed" status
  const pending = allRefunds as any[]

  // Batch-fetch customer names
  const customerIds = [
    ...new Set(
      pending.map((r) => r.customer_id).filter(Boolean) as string[]
    ),
  ]

  const customers =
    customerIds.length > 0
      ? await customerModule.listCustomers({ id: customerIds })
      : []

  const customerMap: Record<string, any> = Object.fromEntries(
    (customers as any[]).map((c) => [c.id, c])
  )

  const enriched = pending.map((r) => {
    const c = customerMap[r.customer_id]
    const customerName = c
      ? [c.first_name, c.last_name].filter(Boolean).join(" ") ||
        c.email ||
        r.customer_id
      : r.customer_id
    return { ...r, customer_name: customerName }
  })

  res.json({ refunds: enriched, count: enriched.length })
}
