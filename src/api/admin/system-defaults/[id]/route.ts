import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

const DB = () => new Client({ connectionString: process.env.DATABASE_URL })

/**
 * PATCH /admin/system-defaults/[id]
 * Update a specific system default
 */
export async function PATCH(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params
    const body = req.body as any

    if (!id) {
        res.status(400).json({ error: "ID is required" })
        return
    }

    const updates: string[] = []
    const values: any[] = []
    let idx = 1

    if (body.context !== undefined) { updates.push(`context = $${idx++}`); values.push(body.context) }
    if (body.field_name !== undefined) { updates.push(`field_name = $${idx++}`); values.push(body.field_name) }
    if (body.value !== undefined) { updates.push(`value = $${idx++}`); values.push(body.value) }
    if (body.sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); values.push(body.sort_order) }
    if (body.data_scope !== undefined) { updates.push(`data_scope = $${idx++}`); values.push(body.data_scope) }

    if (updates.length === 0) {
        res.status(400).json({ error: "No fields to update" })
        return
    }

    updates.push(`updated_at = NOW()`)
    values.push(id)

    const client = DB()
    try {
        await client.connect()
        const { rows } = await client.query(
            `UPDATE system_defaults SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
            values
        )
        if (!rows.length) {
            res.status(404).json({ error: "Not found" })
            return
        }
        res.json({ default: rows[0] })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}

/**
 * DELETE /admin/system-defaults/[id]
 * Delete a specific system default
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params

    if (!id) {
        res.status(400).json({ error: "ID is required" })
        return
    }

    const client = DB()
    try {
        await client.connect()
        await client.query(`DELETE FROM system_defaults WHERE id = $1`, [id])
        res.status(200).json({ success: true, message: "Deleted successfully" })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}
