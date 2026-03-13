/**
 * src/api/admin/document-templates/[id]/duplicate/route.ts
 * POST /admin/document-templates/:id/duplicate
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { generateId } from "../../../../../modules/document-templates/generate-id"

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
        const source = check.rows[0]

        const newId = generateId()
        const now = new Date().toISOString()

        const result = await db.query(
            `INSERT INTO pos_document_template
             (id, name, doc_type, is_default, thumbnail, field_config, layout_data, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                newId,
                `${source.name} (Copy)`,
                source.doc_type,
                false,
                source.thumbnail,
                JSON.stringify(source.field_config ?? {}),
                JSON.stringify(source.layout_data ?? []),
                null,
                now,
                now,
            ]
        )

        return res.status(201).json({ template: result.rows[0] })
    } catch (err) {
        console.error("[DocumentTemplates] POST duplicate error:", err)
        return res.status(500).json({ error: "Failed to duplicate template" })
    } finally {
        await db.end()
    }
}
