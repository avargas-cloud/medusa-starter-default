import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Client } from "pg"

/**
 * GET /admin/customers/[id]/credits
 *
 * Returns the credit balance and ledger history for a customer.
 *
 * Response:
 *   { balance: number, entries: CreditEntry[] }
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const customerId = (req.params as any).id

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        const [balanceRes, entriesRes] = await Promise.all([
            client.query<{ balance: string }>(
                `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
                 FROM customer_credit_ledger
                 WHERE customer_id = $1`,
                [customerId]
            ),
            client.query(
                `SELECT id, amount, type, reference_id, reference_type, note, created_by, created_at
                 FROM customer_credit_ledger
                 WHERE customer_id = $1
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [customerId]
            ),
        ])

        res.json({
            customer_id: customerId,
            balance: parseFloat(balanceRes.rows[0]?.balance ?? "0"),
            entries: entriesRes.rows,
        })
    } catch (err: any) {
        console.error("[CREDIT-LEDGER] GET error:", err)
        res.status(500).json({ error: err.message })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/customers/[id]/credits
 *
 * Adds a credit entry (unapplied payment received from customer).
 * Use when a customer pays without referencing a specific order.
 *
 * Body: { amount: number, note?: string, reference_id?: string, reference_type?: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const customerId = (req.params as any).id
    const { amount, note, reference_id, reference_type } = req.body as {
        amount: number
        note?: string
        reference_id?: string
        reference_type?: string
    }

    if (!amount || amount <= 0) {
        res.status(400).json({ error: "amount must be a positive number" })
        return
    }

    const createdBy = (req as any).auth_context?.actor_id ?? null

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        const result = await client.query(
            `INSERT INTO customer_credit_ledger
                (customer_id, amount, type, reference_id, reference_type, note, created_by)
             VALUES ($1, $2, 'credit', $3, $4, $5, $6)
             RETURNING *`,
            [
                customerId,
                amount,
                reference_id ?? null,
                reference_type ?? "payment",
                note ?? null,
                createdBy,
            ]
        )

        // Return new balance too
        const balanceRes = await client.query<{ balance: string }>(
            `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
             FROM customer_credit_ledger WHERE customer_id = $1`,
            [customerId]
        )

        res.json({
            success: true,
            entry: result.rows[0],
            new_balance: parseFloat(balanceRes.rows[0]?.balance ?? "0"),
        })
    } catch (err: any) {
        console.error("[CREDIT-LEDGER] POST error:", err)
        res.status(500).json({ error: err.message })
    } finally {
        await client.end()
    }
}
