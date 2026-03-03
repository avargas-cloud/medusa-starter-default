import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Pool } from "pg"

/**
 * GET /admin/draft-orders/:id/variant-prices
 *
 * Returns ALL available prices (Default + Price Lists) for a list of variant IDs.
 * Uses direct SQL — most reliable approach for Medusa v2.
 *
 * DB stores amounts in MAJOR UNITS (dollars) — no /100 needed.
 *
 * Query:  ?variant_ids[]=v1&variant_ids[]=v2
 * Response: { prices: { [variantId]: { default?: {amount, currency_code}, list?: [...] } } }
 */
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    let variantIds: string[] = []
    const raw = (req.query as any).variant_ids
    if (Array.isArray(raw)) variantIds = raw.filter(Boolean)
    else if (typeof raw === "string") variantIds = [raw]

    if (variantIds.length === 0) {
        res.status(200).json({ prices: {} })
        return
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL })

    try {
        // ── 1. Fetch DEFAULT prices (no price_list_id) ────────────────────────────
        const defaultRes = await pool.query<{
            variant_id: string
            amount: number
            currency_code: string
        }>(
            `SELECT vps.variant_id, p.amount, p.currency_code
             FROM product_variant_price_set vps
             JOIN price p ON p.price_set_id = vps.price_set_id
                 AND p.deleted_at IS NULL
                 AND p.price_list_id IS NULL
                 AND p.currency_code = 'usd'
             WHERE vps.variant_id = ANY($1)`,
            [variantIds]
        )

        // ── 2. Fetch PRICE LIST prices (Wholesale, etc.) ──────────────────────────
        const listRes = await pool.query<{
            variant_id: string
            amount: number
            currency_code: string
            price_list_id: string
            price_list_title: string
        }>(
            `SELECT vps.variant_id, p.amount, p.currency_code,
                    p.price_list_id, pl.title AS price_list_title
             FROM product_variant_price_set vps
             JOIN price p ON p.price_set_id = vps.price_set_id
                 AND p.deleted_at IS NULL
                 AND p.price_list_id IS NOT NULL
                 AND p.currency_code = 'usd'
             JOIN price_list pl ON pl.id = p.price_list_id
                 AND pl.deleted_at IS NULL
                 AND pl.status = 'active'
             WHERE vps.variant_id = ANY($1)
             ORDER BY vps.variant_id, p.amount`,
            [variantIds]
        )

        // ── 3. Build response map ─────────────────────────────────────────────────
        const prices: Record<string, any> = {}

        for (const vid of variantIds) {
            prices[vid] = { default: null, list: [] }
        }

        for (const row of defaultRes.rows) {
            if (!prices[row.variant_id]) prices[row.variant_id] = { default: null, list: [] }
            if (!prices[row.variant_id].default) {
                prices[row.variant_id].default = {
                    amount: Number(row.amount),
                    currency_code: row.currency_code,
                }
            }
        }

        for (const row of listRes.rows) {
            if (!prices[row.variant_id]) prices[row.variant_id] = { default: null, list: [] }
            prices[row.variant_id].list.push({
                amount: Number(row.amount),
                currency_code: row.currency_code,
                price_list_id: row.price_list_id,
                price_list_name: row.price_list_title,
            })
        }

        res.status(200).json({ prices })
    } catch (e: any) {
        console.error("[variant-prices] SQL error:", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to retrieve prices" })
    } finally {
        await pool.end()
    }
}
