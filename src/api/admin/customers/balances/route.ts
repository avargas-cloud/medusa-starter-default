import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Client } from "pg"

/**
 * GET /admin/customers/balances?customer_ids=id1,id2,...
 *
 * QB-Style AR Balance: Net Balance = credit_ledger_balance − open_orders_outstanding
 *
 * - Positive (+): customer has credit on account
 * - Negative (−): customer owes money (AR outstanding)
 * - Zero (0): balanced
 *
 * Values are in USD (dollars), not cents.
 * order_summary.totals uses human-readable USD floats.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const ids = (req.query.customer_ids as string)?.split(",").filter(Boolean) ?? []

    if (ids.length === 0) {
        res.json({ balances: {} })
        return
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        // 1. Open Orders AR (what customer owes = original - paid)
        const arResult = await client.query<{ customer_id: string; ar_outstanding: string }>(
            `SELECT
                o.customer_id,
                COALESCE(SUM(
                    (os.totals->>'original_order_total')::numeric -
                    (os.totals->>'paid_total')::numeric
                ), 0) AS ar_outstanding
             FROM "order" o
             JOIN order_summary os ON os.order_id = o.id AND os.deleted_at IS NULL
             WHERE o.customer_id = ANY($1)
               AND o.deleted_at IS NULL
               AND o.status != 'canceled'
               AND o.is_draft_order = false
             GROUP BY o.customer_id`,
            [ids]
        )

        // 2. Credit ledger balance (prepayments / on-account credits)
        const creditResult = await client.query<{ customer_id: string; ledger_balance: string }>(
            `SELECT
                customer_id,
                COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS ledger_balance
             FROM customer_credit_ledger
             WHERE customer_id = ANY($1)
             GROUP BY customer_id`,
            [ids]
        )

        // 3. Merge: Net Balance = credits − AR outstanding
        const arMap: Record<string, number> = {}
        for (const row of arResult.rows) {
            arMap[row.customer_id] = parseFloat(row.ar_outstanding)
        }

        const creditMap: Record<string, number> = {}
        for (const row of creditResult.rows) {
            creditMap[row.customer_id] = parseFloat(row.ledger_balance)
        }

        const balances: Record<string, number> = {}
        for (const id of ids) {
            const credit = creditMap[id] ?? 0
            const ar = arMap[id] ?? 0
            balances[id] = credit - ar
        }

        res.json({ balances })
    } catch (err: any) {
        console.error("[AR-BALANCE] Bulk balance error:", err)
        res.status(500).json({ error: err.message })
    } finally {
        await client.end()
    }
}
