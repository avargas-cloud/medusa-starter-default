import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";
import { VALID_BACKLIGHTING_CATEGORIES as VALID_CATEGORIES } from "../_categories";

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

interface ReqWithUser {
    auth_context?: { actor_id?: string; email?: string };
    user?: { email?: string; id?: string };
    body?: unknown;
}

const actorEmail = (req: MedusaRequest): string => {
    const r = req as unknown as ReqWithUser;
    return r.auth_context?.email || r.user?.email || r.auth_context?.actor_id || "unknown";
};

/**
 * POST /admin/backlighting/:variant_id
 * Body: { category: 'led-modules' | ... }
 * Tags a variant as a Backlighting product in the given category.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { variant_id } = req.params as { variant_id: string };
    const { category } = (req.body || {}) as { category?: string };

    if (!category || !VALID_CATEGORIES.has(category)) {
        res.status(400).json({ error: "Invalid or missing category" });
        return;
    }

    const meta = {
        category,
        addedAt: new Date().toISOString(),
        addedBy: actorEmail(req),
    };

    const client = DB();
    await client.connect();
    try {
        const result = await client.query(
            `UPDATE product_variant
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{backlighting}', $1::jsonb, true),
                 updated_at = NOW()
             WHERE id = $2 AND deleted_at IS NULL
             RETURNING id, sku, metadata`,
            [JSON.stringify(meta), variant_id]
        );
        if (result.rowCount === 0) {
            res.status(404).json({ error: "Variant not found" });
            return;
        }
        res.json({ ok: true, variant: result.rows[0] });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Backlighting POST]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}

/**
 * DELETE /admin/backlighting/:variant_id
 * Removes the metadata.backlighting tag from a variant.
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { variant_id } = req.params as { variant_id: string };
    const client = DB();
    await client.connect();
    try {
        const result = await client.query(
            `UPDATE product_variant
             SET metadata = metadata - 'backlighting',
                 updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id, sku`,
            [variant_id]
        );
        if (result.rowCount === 0) {
            res.status(404).json({ error: "Variant not found" });
            return;
        }
        res.json({ ok: true, variant: result.rows[0] });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Backlighting DELETE]", msg);
        res.status(500).json({ error: msg });
    } finally {
        await client.end();
    }
}
