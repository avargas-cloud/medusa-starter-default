import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export const AUTHENTICATE = false;

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

const VALID_CATEGORIES = new Set([
    "led-modules",
    "led-drivers",
    "controllers",
    "amplifiers",
    "remotes",
    "accessories",
]);

/**
 * GET /admin/backlighting?category=led-modules
 * Returns variants tagged with metadata.backlighting.category === <category>.
 * If no category is provided, returns all tagged variants grouped by category.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { category } = req.query as { category?: string };
    const client = DB();
    await client.connect();
    try {
        // SELECT DISTINCT ON (v.id) prevents duplicates when a variant has more
        // than one matching price row (multiple currencies/regions/etc.).
        let sql = `
            SELECT DISTINCT ON (v.id)
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
              AND v.metadata->'backlighting' IS NOT NULL
        `;
        const params: unknown[] = [];
        if (category) {
            if (!VALID_CATEGORIES.has(category)) {
                res.status(400).json({ error: "Invalid category" });
                return;
            }
            sql += ` AND v.metadata->'backlighting'->>'category' = $1`;
            params.push(category);
        }
        // DISTINCT ON requires the dedup key as the leading ORDER BY column.
        sql += ` ORDER BY v.id, p.title, v.title LIMIT 500`;

        const rows = (await client.query(sql, params)).rows;
        res.json({ variants: rows });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Backlighting GET]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
