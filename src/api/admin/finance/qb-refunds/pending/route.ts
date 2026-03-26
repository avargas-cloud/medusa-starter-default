import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse
) => {
  const query = req.scope.resolve("query")
  
  // Fetch refunds that are NOT synced to QB
  const { data: refunds } = await query.graph({
    entity: "refund",
    fields: [
      "id",
      "amount",
      "created_at",
      "payment.*",
      "payment.order.*",
      "payment.order.customer.*",
    ],
    // Only refunds that lack the qb_synced metadata flag
    filters: {
        // In medusa we can filter JSON columns optionally, but usually doing a simple map post-fetch is safer if filters fail
    }
  })

  // We filter in-memory to safely find refunds that don't have metadata.qb_synced === true
  const pendingRefunds = refunds.filter(r => !r.metadata?.qb_synced)

  res.json({
    refunds: pendingRefunds,
    count: pendingRefunds.length,
  })
}
