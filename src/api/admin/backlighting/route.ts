import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";
import { VALID_BACKLIGHTING_CATEGORIES as VALID_CATEGORIES } from "./_categories";

// Authenticated like every /admin route (JWT or secret-key Basic auth — the
// Backlighting sync sends the latter). This route exposes wholesale prices:
// it opted out of auth for months and served them to anyone unauthenticated.

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

/**
 * GET /admin/backlighting?category=led-modules
 * Returns variants tagged with metadata.backlighting.category === <category>.
 * If no category is provided, returns all tagged variants grouped by category.
 */
const parseBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { category } = req.query as { category?: string };
    // Real pagination (the route used to hard-cap at 500 rows with no way to
    // ask for the rest). Callers that omit the params keep the old behavior.
    const limit = parseBoundedInt((req.query as { limit?: string }).limit, 500, 1, 500);
    const offset = parseBoundedInt((req.query as { offset?: string }).offset, 0, 0, 1_000_000);
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
        // DISTINCT ON requires the dedup key as the leading ORDER BY column;
        // v.id leading also makes LIMIT/OFFSET pages stable between requests.
        sql += ` ORDER BY v.id, p.title, v.title LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const rows = (await client.query(sql, params)).rows;
        res.json({ variants: rows, limit, offset });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Backlighting GET]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
