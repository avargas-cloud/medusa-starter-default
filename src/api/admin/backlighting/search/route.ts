import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

/**
 * GET /admin/backlighting/search?q=<text>
 * Free-text search over product title + variant title + sku. Returns up to 50
 * results, INCLUDING variants already tagged (the UI flags them) so the user
 * can see whether a candidate is already in some Backlighting category.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { q } = req.query as { q?: string };
    if (!q || !q.trim()) {
        res.json({ variants: [] });
        return;
    }
    const client = DB();
    await client.connect();
    try {
        const term = `%${q.toLowerCase()}%`;
        const rows = (await client.query(
            `SELECT DISTINCT ON (v.id)
                v.id,
                v.sku,
                v.title AS variant_title,
                v.metadata AS variant_metadata,
                p.id AS product_id,
                p.title AS product_title,
                p.thumbnail,
                (
                    SELECT pr.amount
                    FROM product_variant_price_set psl
                    JOIN price pr ON pr.price_set_id = psl.price_set_id
                    WHERE psl.variant_id = v.id
                      AND pr.currency_code = 'usd'
                      AND pr.deleted_at IS NULL
                      AND pr.price_list_id IS NULL
                    ORDER BY (pr.price_list_id IS NULL) DESC, pr.created_at DESC
                    LIMIT 1
                ) AS standard_price_amount,
                (
                    SELECT pr.amount
                    FROM product_variant_price_set psl
                    JOIN price pr ON pr.price_set_id = psl.price_set_id
                    JOIN price_list pl ON pl.id = pr.price_list_id
                    WHERE psl.variant_id = v.id
                      AND pr.currency_code = 'usd'
                      AND pr.deleted_at IS NULL
                      AND pl.deleted_at IS NULL
                      AND LOWER(pl.title) LIKE '%wholesale%'
                    ORDER BY pr.created_at DESC
                    LIMIT 1
                ) AS wholesale_price_amount,
                'usd' AS currency_code
             FROM product_variant v
             JOIN product p ON v.product_id = p.id
             WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL
               AND (LOWER(p.title) LIKE $1 OR LOWER(v.sku) LIKE $1 OR LOWER(v.title) LIKE $1)
             ORDER BY v.id, p.title, v.title
             LIMIT 50`,
            [term]
        )).rows;
        res.json({ variants: rows });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Backlighting search]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
