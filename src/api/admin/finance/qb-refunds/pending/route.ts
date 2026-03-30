import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { FINANCE_MODULE } from "../../../../../modules/finance"
import { Modules } from "@medusajs/utils"
import { Client } from "pg"

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

  // Batch-fetch pipeline statuses for write_check + refund_payment per refund
  const refundIds = pending.map((r) => r.id).filter(Boolean) as string[]
  const pipelineStatusMap: Record<string, { write_check?: string; refund_payment?: string }> = {}

  if (refundIds.length > 0) {
    const pgClient = new Client({ connectionString: process.env.DATABASE_URL })
    try {
      await pgClient.connect()
      const { rows: pipelineRows } = await pgClient.query(
        `SELECT DISTINCT ON (reference_id, step) reference_id, step, status
         FROM qb_order_pipeline
         WHERE reference_id = ANY($1)
           AND step IN ('write_check', 'refund_payment')
         ORDER BY reference_id, step, COALESCE(updated_at, created_at) DESC`,
        [refundIds]
      )
      for (const row of pipelineRows) {
        if (!pipelineStatusMap[row.reference_id]) pipelineStatusMap[row.reference_id] = {}
        pipelineStatusMap[row.reference_id][row.step as "write_check" | "refund_payment"] = row.status
      }
    } catch {
      // Non-fatal — pipeline statuses are supplemental
    } finally {
      await pgClient.end()
    }
  }

  const enriched = pending.map((r) => {
    const c = customerMap[r.customer_id]
    const customerName = c
      ? [c.first_name, c.last_name].filter(Boolean).join(" ") ||
        c.email ||
        r.customer_id
      : r.customer_id
    const pipeline = pipelineStatusMap[r.id] ?? {}
    return {
      ...r,
      customer_name: customerName,
      write_check_status: pipeline.write_check ?? null,
      refund_payment_status: pipeline.refund_payment ?? null,
    }
  })

  res.json({ refunds: enriched, count: enriched.length })
}
