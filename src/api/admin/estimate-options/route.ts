import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/estimate-options
 * Returns the dropdown option lists for Estimate fields.
 * In the future these can be loaded from a custom DB table.
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse): Promise<void> {
    res.status(200).json({
        payment_terms: [
            "Due on Receipt",
            "30% deposit, 70% upon delivery",
            "50% deposit, 50% upon delivery",
            "70% deposit, 30% upon delivery",
            "80% deposit, 20% upon delivery",
            "Project Completion",
            "Net-7",
            "Net-15",
            "Net-30",
            "Special",
            "Prepaid",
        ],
        lead_times: [
            "In stock as of date on quote",
            "Next business day",
            "2-3 business days",
            "4-5 business days",
            "5-7 business days",
            "7-10 business days",
            "10-15 business days",
            "2-3 weeks",
            "3-4 weeks",
            "4-6 weeks",
            "6-8 weeks",
            "8-10 weeks",
            "10-12 weeks",
            "Specified in Document",
        ],
        order_types: [
            "Regular Order",
            "Special Order",
            "Online Order",
            "Custom Order",
            "Made-to-Order Items",
            "Product Sales & Installation",
            "Service/Installation",
            "Unsatisfied Demand",
        ],
    })
}
