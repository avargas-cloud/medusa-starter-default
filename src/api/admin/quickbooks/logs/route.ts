import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

/**
 * GET /admin/quickbooks/logs
 * Returns recent sync logs with pagination
 */
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        const limit = parseInt(req.query.limit as string) || 10
        const offset = parseInt(req.query.offset as string) || 0
        const type = req.query.type as string | undefined

        await client.connect()

        // Build query with optional type filter
        let whereClause = ""
        const values: any[] = []

        if (type) {
            whereClause = "WHERE type = $1"
            values.push(type)
            values.push(limit, offset)
        } else {
            values.push(limit, offset)
        }

        const query = `
            SELECT 
                id,
                type,
                status,
                message,
                stats,
                started_at,
                completed_at,
                created_at
            FROM quickbooks_logs
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $${values.length - 1} OFFSET $${values.length}
        `

        const result = await client.query(query, values)

        // Get total count
        const countQuery = type
            ? "SELECT COUNT(*) FROM quickbooks_logs WHERE type = $1"
            : "SELECT COUNT(*) FROM quickbooks_logs"

        const countValues = type ? [type] : []
        const countResult = await client.query(countQuery, countValues)
        const total = parseInt(countResult.rows[0].count)

        res.json({
            logs: result.rows,
            pagination: {
                total,
                limit,
                offset,
                hasMore: offset + result.rows.length < total
            }
        })

    } catch (error: any) {
        console.error("Error fetching logs:", error)
        res.status(500).json({
            error: "Failed to fetch logs"
        })
    } finally {
        await client.end()
    }
}
