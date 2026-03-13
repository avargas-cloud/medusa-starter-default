/**
 * src/api/admin/document-templates/[id]/set-default/route.ts
 * POST /admin/document-templates/:id/set-default
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

const DB = () => new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const db = DB()
    try {
        await db.connect()
        const { id } = req.params

        const check = await db.query('SELECT * FROM pos_document_template WHERE id = $1', [id])
        if (!check.rows[0]) return res.status(404).json({ error: "Template not found" })
        const target = check.rows[0]

        // Clear all existing defaults for this doc_type
        await db.query(
            'UPDATE pos_document_template SET is_default = false WHERE doc_type = $1',
            [target.doc_type]
        )

        // Set this one as default
        const result = await db.query(
            'UPDATE pos_document_template SET is_default = true, updated_at = $1 WHERE id = $2 RETURNING *',
            [new Date().toISOString(), id]
        )

        return res.json({ template: result.rows[0] })
    } catch (err) {
        console.error("[DocumentTemplates] POST set-default error:", err)
        return res.status(500).json({ error: "Failed to set default template" })
    } finally {
        await db.end()
    }
}
