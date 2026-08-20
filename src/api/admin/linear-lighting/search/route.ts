import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

/**
 * GET /admin/linear-lighting/search?q=<texto>
 * Busca productos por título o SKU de variante para taggearlos al calculador.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { q } = req.query as { q?: string };
    if (!q || !q.trim()) {
        res.json({ products: [] });
        return;
    }

    const client = DB();
    await client.connect();
    try {
        const rows = (
            await client.query(
                `
                SELECT
                    p.id,
                    p.title,
                    p.thumbnail,
                    p.metadata->'linear_lighting' AS linear_lighting,
                    (
                        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'id', v2.id, 'sku', v2.sku, 'title', v2.title
                        ) ORDER BY v2.variant_rank NULLS LAST, v2.created_at), '[]'::jsonb)
                        FROM product_variant v2
                        WHERE v2.product_id = p.id AND v2.deleted_at IS NULL
                    ) AS variants
                FROM product p
                WHERE p.deleted_at IS NULL
                  AND (
                    p.title ILIKE '%' || $1 || '%'
                    OR EXISTS (
                        SELECT 1 FROM product_variant v
                        WHERE v.product_id = p.id
                          AND v.deleted_at IS NULL
                          AND v.sku ILIKE '%' || $1 || '%'
                    )
                  )
                ORDER BY p.title
                LIMIT 30
                `,
                [q.trim()]
            )
        ).rows;
        res.json({ products: rows });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[LinearLighting SEARCH]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
