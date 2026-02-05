import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { email } = req.query as { email?: string }

    if (!email) {
        return res.status(400).json({
            error: "Email parameter is required"
        })
    }

    try {
        const query = req.scope.resolve("query")

        // Find customer by email using Query API
        const { data: customers } = await query.graph({
            entity: "customer",
            filters: { email },
            fields: ["id", "email", "has_account", "metadata"]
        })

        if (!customers || customers.length === 0) {
            return res.json({
                exists: false,
                has_account: null,
                is_legacy: false
            })
        }

        const customer = customers[0]!  // Safe: checked exists above

        return res.json({
            exists: true,
            has_account: customer.has_account || false,
            is_legacy: customer.metadata?.legacy_customer === true
        })

    } catch (error) {
        console.error('Error checking customer email:', error)
        return res.status(500).json({
            error: "Failed to check customer email",
            details: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
