import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"
import { Client } from "pg"

/**
 * GET /admin/finance/qb-refunds/pending
 *
 * Returns payments that need a QB Write Check:
 *   - New style: type IN ('payment','credit_memo') with status IN ('refunded','partial_refunded')
 *   - Old style (backwards compat): type='refund' records created before migration
 * Enriched with customer name and pipeline statuses for the accounting page.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerModule = req.scope.resolve(Modules.CUSTOMER)
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL })

  try {
    await pgClient.connect()

    // Fetch all refund-pending payments (new + legacy style)
    const { rows: allRefunds } = await pgClient.query(`
      SELECT *
      FROM customer_payment
      WHERE
        (type != 'refund' AND status IN ('refunded', 'partial_refunded'))
        OR type = 'refund'
      ORDER BY received_at DESC
    `)

    if (allRefunds.length === 0) {
      return res.json({ refunds: [], count: 0 })
    }

    // Batch-fetch customer names
    const customerIds = [...new Set(allRefunds.map((r) => r.customer_id).filter(Boolean) as string[])]
    const customers = customerIds.length > 0
      ? await customerModule.listCustomers({ id: customerIds })
      : []

    const customerMap: Record<string, any> = Object.fromEntries(
      (customers as any[]).map((c) => [c.id, c])
    )

    // Batch-fetch pipeline statuses
    const refundIds = allRefunds.map((r) => r.id).filter(Boolean) as string[]
    const pipelineStatusMap: Record<string, {
      write_check?: string
      refund_payment?: string
      bankAccountId?: string
    }> = {}

    const { rows: pipelineRows } = await pgClient.query(
      `SELECT DISTINCT ON (reference_id, step) reference_id, step, status, payload
       FROM qb_order_pipeline
       WHERE reference_id = ANY($1)
         AND step IN ('write_check', 'refund_payment')
       ORDER BY reference_id, step, COALESCE(updated_at, created_at) DESC`,
      [refundIds]
    )

    for (const row of pipelineRows) {
      if (!pipelineStatusMap[row.reference_id]) pipelineStatusMap[row.reference_id] = {}
      const entry = pipelineStatusMap[row.reference_id]!
      entry[row.step as "write_check" | "refund_payment"] = row.status
      if (row.step === "write_check" && row.payload?.bankAccountId) {
        entry.bankAccountId = row.payload.bankAccountId
      }
    }

    const enriched = allRefunds.map((r) => {
      const c = customerMap[r.customer_id]
      const customerName = c
        ? [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || r.customer_id
        : r.customer_id
      const pipeline = pipelineStatusMap[r.id] ?? {}

      // Amount: for new-style refunds use metadata.refund_amount; for old-style use amount
      const refundAmount = r.type !== 'refund' && r.metadata?.refund_amount
        ? Number(r.metadata.refund_amount)
        : Number(r.amount)

      return {
        ...r,
        amount: refundAmount,
        customer_name: customerName,
        write_check_status: pipeline.write_check ?? null,
        refund_payment_status: pipeline.refund_payment ?? null,
        qb_bank_account_id: pipeline.bankAccountId ?? null,
      }
    })

    return res.json({ refunds: enriched, count: enriched.length })
  } finally {
    await pgClient.end()
  }
}
