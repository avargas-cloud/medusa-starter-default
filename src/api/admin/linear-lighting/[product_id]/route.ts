import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";
import { VALID_LL_CATEGORIES, VALID_LL_SYSTEMS } from "../_lib/constants";

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

interface ReqWithUser {
    auth_context?: { actor_id?: string; email?: string };
    user?: { email?: string; id?: string };
}

const actorEmail = (req: MedusaRequest): string => {
    const r = req as unknown as ReqWithUser;
    return r.auth_context?.email || r.user?.email || r.auth_context?.actor_id || "unknown";
};

/**
 * POST /admin/linear-lighting/:product_id
 * Body: la config completa `linear_lighting` del producto (category, systems,
 * friendly_name, campos eléctricos por categoría). Se escribe con jsonb_set
 * sobre LA clave — nunca reemplaza el metadata entero (gotcha conocido de
 * Medusa: update de metadata pisa/mergea según la entidad; SQL dirigido es
 * inmune a ambos).
 * La validación ESTRICTA del shape vive en el sync del backend Linear Lighting
 * (zod de shared/catalog-types) — acá se valida lo mínimo para no persistir basura.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { product_id } = req.params as { product_id: string };
    const body = (req.body || {}) as Record<string, unknown>;

    const category = body.category;
    if (typeof category !== "string" || !VALID_LL_CATEGORIES.has(category)) {
        res.status(400).json({ error: "Invalid or missing category" });
        return;
    }
    const systems = body.systems;
    if (
        !Array.isArray(systems) ||
        systems.some((s) => typeof s !== "string" || !VALID_LL_SYSTEMS.has(s))
    ) {
        res.status(400).json({ error: "systems must be an array of 'easyled' | 'essential'" });
        return;
    }

    const client = DB();
    await client.connect();
    try {
        const existing = await client.query(
            `SELECT metadata->'linear_lighting'->>'added_at' AS added_at,
                    metadata->'linear_lighting'->>'added_by' AS added_by
             FROM product WHERE id = $1 AND deleted_at IS NULL`,
            [product_id]
        );
        if (existing.rowCount === 0) {
            res.status(404).json({ error: "Product not found" });
            return;
        }
        const prev = existing.rows[0] as { added_at: string | null; added_by: string | null };
        const meta = {
            ...body,
            added_at: prev.added_at ?? new Date().toISOString(),
            added_by: prev.added_by ?? actorEmail(req),
            updated_at: new Date().toISOString(),
            updated_by: actorEmail(req),
        };

        const result = await client.query(
            `UPDATE product
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{linear_lighting}', $1::jsonb, true),
                 updated_at = NOW()
             WHERE id = $2 AND deleted_at IS NULL
             RETURNING id, title, metadata->'linear_lighting' AS linear_lighting`,
            [JSON.stringify(meta), product_id]
        );
        res.json({ ok: true, product: result.rows[0] });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[LinearLighting POST]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}

/**
 * DELETE /admin/linear-lighting/:product_id
 * Saca el producto del calculador (remueve la clave linear_lighting).
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { product_id } = req.params as { product_id: string };
    const client = DB();
    await client.connect();
    try {
        const result = await client.query(
            `UPDATE product
             SET metadata = metadata - 'linear_lighting',
                 updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id, title`,
            [product_id]
        );
        if (result.rowCount === 0) {
            res.status(404).json({ error: "Product not found" });
            return;
        }
        res.json({ ok: true, product: result.rows[0] });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[LinearLighting DELETE]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
