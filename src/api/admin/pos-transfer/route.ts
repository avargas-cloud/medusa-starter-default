import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * POST /admin/pos-transfer
 * 
 * Forcefully transfers an Order or Draft Order to a new customer.
 * Native Medusa transfer endpoints require a token-based acceptance flow, 
 * which does not fit an immediate POS UI update.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { id, customer_id, email } = req.body as { id: string, customer_id: string, email?: string }

    if (!id || !customer_id) {
      return res.status(400).json({ error: "id and customer_id are required" })
    }

    const orderModule = req.scope.resolve("order")
    
    // Attempt update natively bypassing REST restrictions
    const result = await orderModule.updateOrders([{
      id,
      customer_id,
      email
    }])

    return res.status(200).json({ success: true, message: `Successfully transferred ownership to customer ${customer_id}`, order: result[0] })
  } catch (error: any) {
    console.error("[pos-transfer]", error)
    return res.status(500).json({ error: error.message })
  }
}
