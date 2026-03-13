/**
 * src/api/pos/document-templates/[id]/route.ts
 * GET    /pos/document-templates/:id
 * PATCH  /pos/document-templates/:id
 * DELETE /pos/document-templates/:id
 *
 * Includes layout_guides persistence support.
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

const DB = () => new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
})

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const db = DB()
    try {
        await db.connect()
        const { id } = req.params
        const result = await db.query('SELECT * FROM pos_document_template WHERE id = $1', [id])
        if (!result.rows[0]) return res.status(404).json({ error: "Template not found" })
        return res.json({ template: result.rows[0] })
    } catch (err) {
        console.error("[POS/DocumentTemplates] GET :id error:", err)
        return res.status(500).json({ error: "Failed to get template" })
    } finally {
        await db.end()
    }
}

export const PATCH = async (req: MedusaRequest, res: MedusaResponse) => {
    const db = DB()
    try {
        await db.connect()
        const { id } = req.params
        const body = req.body as {
            name?: string
            field_config?: Record<string, any>
            layout_data?: any[]
            layout_guides?: any[]
            thumbnail?: string
            is_default?: boolean
        }

        const check = await db.query('SELECT * FROM pos_document_template WHERE id = $1', [id])
        if (!check.rows[0]) return res.status(404).json({ error: "Template not found" })
        const existing = check.rows[0]

        // Auto-migrate: ensure layout_guides column exists (idempotent)
        if (body.layout_guides !== undefined) {
            await db.query(`ALTER TABLE pos_document_template ADD COLUMN IF NOT EXISTS layout_guides JSONB DEFAULT '[]'`)
        }

        const updates: string[] = []
        const values: any[] = []
        let i = 1

        if (body.name !== undefined)          { updates.push(`name = $${i++}`);          values.push(body.name) }
        if (body.field_config !== undefined)  { updates.push(`field_config = $${i++}`);  values.push(JSON.stringify(body.field_config)) }
        if (body.layout_data !== undefined)   { updates.push(`layout_data = $${i++}`);   values.push(JSON.stringify(body.layout_data)) }
        if (body.layout_guides !== undefined) { updates.push(`layout_guides = $${i++}`); values.push(JSON.stringify(body.layout_guides)) }
        if (body.thumbnail !== undefined)     { updates.push(`thumbnail = $${i++}`);     values.push(body.thumbnail) }
        if (body.is_default !== undefined)    { updates.push(`is_default = $${i++}`);    values.push(body.is_default) }

        if (updates.length === 0) return res.json({ template: existing })

        updates.push(`updated_at = $${i++}`)
        values.push(new Date().toISOString())
        values.push(id)

        if (body.is_default) {
            await db.query(
                'UPDATE pos_document_template SET is_default = false WHERE doc_type = $1 AND id != $2',
                [existing.doc_type, id]
            )
        }

        const result = await db.query(
            `UPDATE pos_document_template SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
            values
        )

        return res.json({ template: result.rows[0] })
    } catch (err) {
        console.error("[POS/DocumentTemplates] PATCH :id error:", err)
        return res.status(500).json({ error: "Failed to update template" })
    } finally {
        await db.end()
    }
}

export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
    const db = DB()
    try {
        await db.connect()
        const { id } = req.params
        const check = await db.query('SELECT id FROM pos_document_template WHERE id = $1', [id])
        if (!check.rows[0]) return res.status(404).json({ error: "Template not found" })
        await db.query('DELETE FROM pos_document_template WHERE id = $1', [id])
        return res.json({ deleted: true, id })
    } catch (err) {
        console.error("[POS/DocumentTemplates] DELETE :id error:", err)
        return res.status(500).json({ error: "Failed to delete template" })
    } finally {
        await db.end()
    }
}
