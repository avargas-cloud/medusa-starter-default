import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { DB, ensureTable } from "../route"
import { IUserModuleService } from "@medusajs/framework/types"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const userModule: IUserModuleService = req.scope.resolve("user")

    try {
        // 1. Fetch all active users from Medusa V2
        const users = await userModule.listUsers({}, { select: ["id", "first_name", "last_name", "email"] })

        const client = DB()
        await client.connect()
        await ensureTable(client)

        try {
            await client.query("BEGIN")

            // 2. Fetch existing sales rep entries
            const { rows: existingRows } = await client.query(
                `SELECT id, value, sort_order FROM system_defaults WHERE context = 'Global' AND field_name = 'Sales Rep User'`
            )

            // Parse existing entries — separate manual users from Medusa-linked ones
            const existingMap = new Map<string, any>()  // medusa_id → { ...parsed, _db_id }
            let maxSort = 0

            for (const row of existingRows) {
                try {
                    const parsed = JSON.parse(row.value)
                    if (parsed.medusa_id) {
                        existingMap.set(parsed.medusa_id, { ...parsed, _db_id: row.id })
                    }
                } catch { /* ignore malformed JSON */ }
                if (row.sort_order > maxSort) maxSort = row.sort_order
            }

            // 3. Build a Set of current Medusa user IDs for O(1) lookup
            const medusaIds = new Set(users.map(u => u.id))

            let insertedCount = 0
            let removedCount = 0

            // 4. Remove stale Medusa-linked entries (user was deleted from Medusa)
            //    NEVER remove manual users (medusa_id starts with "manual-")
            for (const [mid, entry] of existingMap) {
                const isManual = mid.startsWith("manual-")
                if (!isManual && !medusaIds.has(mid)) {
                    await client.query(
                        `DELETE FROM system_defaults WHERE id = $1`,
                        [entry._db_id]
                    )
                    removedCount++
                }
            }

            // 5. Insert new Medusa users that don't exist yet
            for (const u of users) {
                if (existingMap.has(u.id)) {
                    // Already exists — leave initials/is_sales_rep as-is (user may have edited them)
                    continue
                }

                const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email
                const defaultInitials = [u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join("").toUpperCase() || "XX"

                const newUserObj = {
                    medusa_id: u.id,
                    name,
                    email: u.email,
                    is_sales_rep: false,
                    initials: defaultInitials,
                    active: true,
                }

                maxSort++
                await client.query(
                    `INSERT INTO system_defaults (context, field_name, value, sort_order) VALUES ($1, $2, $3, $4)`,
                    ["Global", "Sales Rep User", JSON.stringify(newUserObj), maxSort]
                )
                insertedCount++
            }

            await client.query("COMMIT")

            const parts: string[] = []
            if (insertedCount > 0) parts.push(`${insertedCount} new user(s) added`)
            if (removedCount > 0)  parts.push(`${removedCount} deleted user(s) removed`)
            if (parts.length === 0) parts.push("already up to date")

            res.status(200).json({
                success: true,
                count: insertedCount,
                removed: removedCount,
                message: `Sync complete — ${parts.join(", ")}.`,
            })

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
