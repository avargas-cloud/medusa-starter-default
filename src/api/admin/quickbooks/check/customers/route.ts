import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { checkCustomersCore } from "../../../../../lib/quickbooks/check-customers-core"

/**
 * GET /admin/quickbooks/check/customers
 * Returns the latest customer audit results from database
 */
export async function GET(
    _req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        const result = await client.query(`
            SELECT * FROM quickbooks_customer_audit
            WHERE id = 'latest'
        `)

        if (result.rows.length === 0) {
            res.status(404).json({
                error: "No audit results found. Run a check first."
            })
            return
        }

        const audit = result.rows[0]

        res.json({
            audit: {
                stats: {
                    totalInQb: audit.total_in_qb,
                    totalInMedusa: audit.total_in_medusa,
                    onlyInQb: audit.only_in_qb,
                    onlyInMedusa: audit.only_in_medusa,
                    inBoth: audit.in_both
                },
                customersOnlyInQb: audit.customers_only_in_qb || [],
                customersOnlyInMedusa: audit.customers_only_in_medusa || [],
                lastCheckAt: audit.last_check_at
            }
        })

    } catch (error: any) {
        console.error("Error fetching customer audit:", error)
        res.status(500).json({
            error: "Failed to fetch audit results"
        })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/quickbooks/check/customers
 * Executes customer check/audit and saves results
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    try {
        // TODO: Move to background job for production
        const result = await checkCustomersCore(req.scope)

        if (!result.success) {
            res.status(500).json({
                error: result.error || "Check failed",
                stats: result.stats
            })
            return
        }

        res.json({
            success: true,
            stats: result.stats,
            customersOnlyInQb: result.customersOnlyInQb,
            customersOnlyInMedusa: result.customersOnlyInMedusa,
            message: "Customer check completed successfully"
        })

    } catch (error: any) {
        console.error("Error checking customers:", error)
        res.status(500).json({
            error: "Failed to execute customer check"
        })
    }
}
