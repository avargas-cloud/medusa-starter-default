import { getOrdersListWorkflow } from "@medusajs/core-flows"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const workflow = getOrdersListWorkflow(req.scope)
    const { result } = await workflow.run({
        input: {
            // Note: The Admin list view loads fewer fields than the detail view
            fields: [
                "id", "display_id", "status", "version", "summary", "total", "metadata", "locale", "created_at", "updated_at"
            ],
            variables: {
                filters: { status: "pending" },
                skip: 0,
                take: 10
            }
        }
    })

    res.json({ debug_orders: result })
}
