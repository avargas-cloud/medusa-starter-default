import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { DB, ensureTable } from "../route"
import { IUserModuleService } from "@medusajs/framework/types"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const userModule: IUserModuleService = req.scope.resolve("user")

    try {
        // 1. Fetch all active users from Medusa V2
        const users = await userModule.listUsers({}, { select: ["id", "first_name", "last_name", "email"] })

        if (!users.length) {
            res.status(200).json({ skipped: true, message: "No active users found in Medusa" })
            return
        }

        const client = DB()
        await client.connect()
        await ensureTable(client)

        try {
            await client.query("BEGIN")

            // 2. Fetch existing sales rep entries
            const { rows: existingRows } = await client.query(
                `SELECT id, value, sort_order FROM system_defaults WHERE context = 'Global' AND field_name = 'Sales Rep User'`
            )

            // Map existing by medusa_id for quick merging
            const existingMap = new Map<string, any>()
            let maxSort = 0

            for (const row of existingRows) {
                try {
                    const parsed = JSON.parse(row.value)
                    if (parsed.medusa_id) existingMap.set(parsed.medusa_id, { ...parsed, _db_id: row.id })
                } catch { /* ignore malformed JSON */ }
                if (row.sort_order > maxSort) maxSort = row.sort_order
            }

            let insertedCount = 0

            // 3. Process Medusa users
            for (const u of users) {
                const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email
                const defaultInitials = [u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join("").toUpperCase() || "XX"

                // Check if user already exists
                if (existingMap.has(u.id)) {
                    // We don't overwrite if they exist; the user might have manually edited Initials or Is Sales Rep status.
                    // We just leave them alone (per user request: "EL SYNC ES SOLO PARA CHEQUEAR SI HAY NUEVOS USUARIOS")
                    continue
                }

                // New User -> Add them with Sales Rep = NO
                const newUserObj = {
                    medusa_id: u.id,
                    name: name,
                    email: u.email,
                    is_sales_rep: false,
                    initials: defaultInitials,
                    active: true
                }

                maxSort++
                await client.query(
                    `INSERT INTO system_defaults (context, field_name, value, sort_order) VALUES ($1, $2, $3, $4)`,
                    ['Global', 'Sales Rep User', JSON.stringify(newUserObj), maxSort]
                )
                insertedCount++
            }

            await client.query("COMMIT")
            res.status(200).json({ success: true, count: insertedCount, message: `Synced ${insertedCount} new users successfully.` })

        } catch (dbError) {
            await client.query("ROLLBACK")
            throw dbError
        } finally {
            await client.end()
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message })
    }
}
