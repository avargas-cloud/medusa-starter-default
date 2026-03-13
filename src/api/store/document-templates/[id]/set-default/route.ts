/**
 * src/api/store/document-templates/[id]/set-default/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

const DB = () => new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false } : false,
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const db = DB()
    try {
        await db.connect()
        const src = await db.query('SELECT * FROM pos_document_template WHERE id = $1', [req.params.id])
        if (!src.rows[0]) return res.status(404).json({ error: "Template not found" })
        const t = src.rows[0]
        await db.query('UPDATE pos_document_template SET is_default = false WHERE doc_type = $1', [t.doc_type])
        await db.query('UPDATE pos_document_template SET is_default = true WHERE id = $1', [req.params.id])
        return res.json({ success: true })
    } catch (err) {
        console.error("[Store/DocumentTemplates] set-default error:", err)
        return res.status(500).json({ error: "Failed to set default" })
    } finally { await db.end() }
}
