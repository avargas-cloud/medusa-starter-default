import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

export const DB = () => new Client({ connectionString: process.env.DATABASE_URL })

// ── Default System Defaults ──────────────────────────────────────────────────
const DEFAULT_VALUES = [
    // Document Defaults (Consolidated)
    { context: "Document Defaults", field_name: "Terms", value: "Due on Receipt", sort_order: 1 },
    { context: "Document Defaults", field_name: "Terms", value: "Net 15", sort_order: 2 },
    { context: "Document Defaults", field_name: "Terms", value: "Net 30", sort_order: 3 },
    { context: "Document Defaults", field_name: "Terms", value: "Net 45", sort_order: 4 },
    { context: "Document Defaults", field_name: "Terms", value: "Net 60", sort_order: 5 },

    { context: "Document Defaults", field_name: "Tax Code", value: "TAX", sort_order: 1 },
    { context: "Document Defaults", field_name: "Tax Code", value: "NON", sort_order: 2 },

    { context: "Document Defaults", field_name: "Order Type", value: "Standard Order", sort_order: 1 },
    { context: "Document Defaults", field_name: "Order Type", value: "Store Pickup", sort_order: 2 },
    { context: "Document Defaults", field_name: "Order Type", value: "Project", sort_order: 3 },

    { context: "Document Defaults", field_name: "Lead Time", value: "Immediate", sort_order: 1 },
    { context: "Document Defaults", field_name: "Lead Time", value: "1-2 Business Days", sort_order: 2 },
    { context: "Document Defaults", field_name: "Lead Time", value: "3-5 Business Days", sort_order: 3 },
    { context: "Document Defaults", field_name: "Lead Time", value: "5-7 Business Days", sort_order: 4 },
    { context: "Document Defaults", field_name: "Lead Time", value: "7-14 Business Days", sort_order: 5 },

    // Templates Footer
    {
        context: "Templates Footer",
        field_name: "Draft Order (Estimates)",
        value: `STORE POLICIES
·REFUND within 15 days. Product(s) in original condition.
·EXCHANGE / CREDIT within 30 days. Product(s) in original condition.
·SPECIAL ORDERS subject to 25% restocking fee.
·CUSTOM ORDERS not returnable nor cancellable.
·MADE TO ORDER returns subject to approval, commonly not returnable/cancellable.
·ECOPOWERTECH not responsible for damages after goods leave our premises.`,
        sort_order: 1
    },
]

// ── Ensure table + seed ────────────────────────────────────────────────────────

export async function ensureTable(client: Client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS system_defaults (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            context     TEXT NOT NULL,
            field_name  TEXT NOT NULL,
            value       TEXT NOT NULL,
            sort_order  INT  NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(context, field_name, value)
        )
    `)

    // Temporary Migration logic for consolidated Document Defaults
    try {
        await client.query(`
            UPDATE system_defaults 
            SET context = 'Document Defaults' 
            WHERE context IN ('Customer Defaults', 'Order Defaults')
            AND NOT EXISTS (
                SELECT 1 FROM system_defaults sd2 
                WHERE sd2.context = 'Document Defaults' 
                AND sd2.field_name = system_defaults.field_name 
                AND sd2.value = system_defaults.value
            )
        `)
        await client.query(`
            DELETE FROM system_defaults WHERE context IN ('Customer Defaults', 'Order Defaults')
        `)
    } catch (e) {
        // ignore unique constraint errors from migration
    }

    const { rowCount } = await client.query("SELECT 1 FROM system_defaults LIMIT 1")
    if (!rowCount) {
        // Single batch INSERT for seeding
        const values: any[] = []
        const placeholders = DEFAULT_VALUES.map((p, i) => {
            const base = i * 4
            values.push(p.context, p.field_name, p.value, p.sort_order)
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`
        })
        await client.query(
            `INSERT INTO system_defaults (context, field_name, value, sort_order) VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`,
            values
        )
    }
}

/**
 * GET /admin/system-defaults
 * Returns all defaults ordered by context, field_name, sort_order
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const client = DB()
    try {
        await client.connect()
        await ensureTable(client)
        const { rows } = await client.query(
            `SELECT * FROM system_defaults ORDER BY context, field_name, sort_order, value`
        )
        res.json({ defaults: rows })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/system-defaults
 * Creates a new system default value
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { context, field_name, value, sort_order = 0 } = req.body as any
    if (!context || !field_name || !value) {
        res.status(400).json({ error: "context, field_name, and value are required" })
        return
    }
    const client = DB()
    try {
        await client.connect()
        await ensureTable(client)
        const { rows } = await client.query(
            `INSERT INTO system_defaults (context, field_name, value, sort_order)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [context, field_name, value, sort_order]
        )
        res.status(201).json({ default: rows[0] })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}
