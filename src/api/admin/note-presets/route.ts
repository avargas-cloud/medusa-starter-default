import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

const DB = () => new Client({ connectionString: process.env.DATABASE_URL })

// ── Default presets ───────────────────────────────────────────────────────────
const DEFAULT_PRESETS = [
    // Store Policy
    {
        group_name: "Store Policy", title: "Payment Terms", sort_order: 1,
        content: "PAYMENT TERMS: Net 30 days from invoice date. A late fee of 1.5% per month will be applied to overdue balances.",
    },
    {
        group_name: "Store Policy", title: "Lead Time", sort_order: 2,
        content: "LEAD TIME: Standard lead time is 5–7 business days from order confirmation. Lead times may vary based on product availability and order volume.",
    },
    {
        group_name: "Store Policy", title: "Validity", sort_order: 3,
        content: "QUOTE VALIDITY: This quote is valid for 30 calendar days from the date of issue. After this period, prices are subject to change without notice.",
    },
    {
        group_name: "Store Policy", title: "Warranty", sort_order: 4,
        content: "WARRANTY: Products are warranted for 5 years from the date of purchase against manufacturing defects under normal use conditions.",
    },
    {
        group_name: "Store Policy", title: "Scope Note", sort_order: 5,
        content: "SCOPE: This quote covers only the items listed in the bill of materials. Any additional items, services, or modifications will require a separate quote.",
    },
    // Scope of Work
    {
        group_name: "Scope of Work", title: "Materials Only", sort_order: 1,
        content: "This estimate covers the supply of specified materials and equipment only, as outlined in the bill of materials. Installation, configuration, labor, or any other services are not included unless explicitly stated.",
    },
    {
        group_name: "Scope of Work", title: "Custom Fabrication", sort_order: 2,
        content: "This estimate includes custom fabrication of components per the approved design specifications. Changes to design or scope after approval may affect pricing and lead times and will require a written change order.",
    },
    {
        group_name: "Scope of Work", title: "Partial Orders", sort_order: 3,
        content: "Price is based on the full bill of materials as listed. Partial orders or split releases will not be accepted and will require a revised quote. No deviations will be honored without prior written approval.",
    },
    // Installation
    {
        group_name: "Installation", title: "No Service", sort_order: 1,
        content: "This estimate includes only the cost of goods or materials. It does not cover any services, such as product assembly, on-site installation, configuration, or programming.",
    },
    {
        group_name: "Installation", title: "Assembly – LED Panels", sort_order: 2,
        content: `ASSEMBLY SERVICE NOTES:
- Covers the arrangement and electrical integration of LED module panels onto wooden bases, custom-fitted to exact measurements.
- The lighting will be mounted and configured on the wooden base, designed for placement behind the translucent stone to streamline and expedite the on-site installation process.
- Note: On-site installation is not included.
- Lead Time: A minimum of 2 business days is required after receiving the wooden bases. Lead times may vary depending on project complexity, volume, and current workload.`,
    },
    {
        group_name: "Installation", title: "Assembly – Linear", sort_order: 3,
        content: `ASSEMBLY SERVICE NOTES:
- Includes the preparation of Linear Lighting segments, combining LED strips and aluminum profiles based on your project requirements.
- Services include cutting LED strips and aluminum profiles to specified lengths and soldering cables as needed.
- Lead Time: A minimum of 2 business days is required for assembly. Please note that lead times may vary depending on project complexity, volume, and our current workload.
- Important note: This service does not include on-site installation.`,
    },
    // Projects
    {
        group_name: "Projects", title: "Project Notes", sort_order: 1,
        content: `PROJECT REMARKS:
- PAYMENT TERMS: 50% DEPOSIT, 50% UPON DELIVERY.
- MUST HAVE THE 2023 TAX-EXEMPT CERTIFICATE OTHERWISE SALES TAX WILL BE CHARGED.
- PURCHASE ORDER SUBJECT TO ECOPOWERTECH'S TERMS AND CONDITIONS.
- WE WILL ONLY ACCEPT ORDERS FOR IMMEDIATE RELEASE.
- PRICE IS BASED ON THE ENTIRE BILL OF MATERIAL, NO PARTIALS. ANY DEVIATION WILL RESULT IN A NEW QUOTE.
- PRICE IS BASED ON DOMESTIC PACKAGING ONLY.
- IF DELIVERY SERVICE IS NEEDED, FREIGHT FORWARDER INFORMATION IS NEEDED INCLUDING CONTACT NAME AND NUMBER.
- PRODUCTS ARE WARRANTED FOR 5 YEARS FROM THE DAY OF PURCHASE.
- ORDER IS NON-CANCELLABLE, NON-RETURNABLE.
- LEAD TIME: 7–10 BUSINESS DAYS.`,
    },
]

// ── Ensure table + seed ────────────────────────────────────────────────────────
async function ensureTable(client: Client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS note_presets (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            group_name  TEXT NOT NULL,
            title       TEXT NOT NULL,
            content     TEXT NOT NULL,
            sort_order  INT  NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    const { rowCount } = await client.query("SELECT 1 FROM note_presets LIMIT 1")
    if (!rowCount) {
        // Single batch INSERT — much faster than individual round-trips
        const values: any[] = []
        const placeholders = DEFAULT_PRESETS.map((p, i) => {
            const base = i * 4
            values.push(p.group_name, p.title, p.content, p.sort_order)
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`
        })
        await client.query(
            `INSERT INTO note_presets (group_name, title, content, sort_order) VALUES ${placeholders.join(", ")}`,
            values
        )
    }
}

/**
 * GET /admin/note-presets
 * Returns all presets ordered by group, sort_order
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const client = DB()
    try {
        await client.connect()
        await ensureTable(client)
        const { rows } = await client.query(
            `SELECT * FROM note_presets ORDER BY group_name, sort_order, title`
        )
        res.json({ presets: rows })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/note-presets
 * Creates a new preset
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { group_name, title, content, sort_order = 0 } = req.body as any
    if (!group_name || !title || !content) {
        res.status(400).json({ error: "group_name, title, and content are required" })
        return
    }
    const client = DB()
    try {
        await client.connect()
        await ensureTable(client)
        const { rows } = await client.query(
            `INSERT INTO note_presets (group_name, title, content, sort_order)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [group_name, title, content, sort_order]
        )
        res.status(201).json({ preset: rows[0] })
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    } finally {
        await client.end()
    }
}
