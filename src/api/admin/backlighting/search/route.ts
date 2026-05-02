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
                p.thumbnail
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
