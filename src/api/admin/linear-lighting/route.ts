import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";
import { VALID_LL_CATEGORIES, VALID_LL_SYSTEMS } from "./_lib/constants";

// Auth intencionalmente ACTIVA (default). La ruta homóloga de backlighting
// quedó con AUTHENTICATE=false y expone precios públicamente — no repetir.

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

/**
 * GET /admin/linear-lighting?category=strip&system=easyled
 * Productos taggeados con metadata.linear_lighting, con sus variantes (SKUs)
 * y precios standard/wholesale de la primera variante.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { category, system } = req.query as { category?: string; system?: string };
    if (category && !VALID_LL_CATEGORIES.has(category)) {
        res.status(400).json({ error: "Invalid category" });
        return;
    }
    if (system && !VALID_LL_SYSTEMS.has(system)) {
        res.status(400).json({ error: "Invalid system" });
        return;
    }

    const client = DB();
    await client.connect();
    try {
        let sql = `
            SELECT
                p.id,
                p.title,
                p.thumbnail,
                p.metadata->'linear_lighting' AS linear_lighting,
                (
                    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'id', v.id,
                        'sku', v.sku,
                        'title', v.title
                    ) ORDER BY v.variant_rank NULLS LAST, v.created_at), '[]'::jsonb)
                    FROM product_variant v
                    WHERE v.product_id = p.id AND v.deleted_at IS NULL
                ) AS variants
            FROM product p
            WHERE p.deleted_at IS NULL
              AND p.metadata->'linear_lighting' IS NOT NULL
        `;
        const params: unknown[] = [];
        if (category) {
            params.push(category);
            sql += ` AND p.metadata->'linear_lighting'->>'category' = $${params.length}`;
        }
        if (system) {
            params.push(JSON.stringify([system]));
            sql += ` AND p.metadata->'linear_lighting'->'systems' @> $${params.length}::jsonb`;
        }
        sql += ` ORDER BY p.title LIMIT 500`;

        const rows = (await client.query(sql, params)).rows;
        res.json({ products: rows });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[LinearLighting GET]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
