/**
 * src/api/admin/settings/admin-pass/route.ts
 *
 * POST /admin/settings/admin-pass  → validate code (returns { valid: boolean } only — never exposes stored value)
 * PUT  /admin/settings/admin-pass  → update the stored code (admin-authenticated)
 *
 * Storage: store.metadata.admin_override_pass in the Medusa store table.
 * Fallback: ADMIN_OVERRIDE_PASS env var → '20110412Ept' if neither is set.
 *
 * Used by the POS "Refund / Credit Memo" late-return authorization flow.
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Client } from 'pg'

const DEFAULT_PASS = process.env.ADMIN_OVERRIDE_PASS ?? '20110412Ept'

async function getStoredPass(): Promise<string> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()
        const { rows } = await client.query<{ metadata: Record<string, any> | null }>(
            `SELECT metadata FROM store LIMIT 1`
        )
        return (rows[0]?.metadata?.admin_override_pass as string) || DEFAULT_PASS
    } catch {
        return DEFAULT_PASS
    } finally {
        await client.end()
    }
}

/** POST — validate without exposing the stored value */
export async function POST(
    req: AuthenticatedMedusaRequest<{ code?: string }>,
    res: MedusaResponse
) {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: 'code is required' })

    const stored = await getStoredPass()
    return res.json({ valid: code === stored })
}

/** PUT — update the stored code */
export async function PUT(
    req: AuthenticatedMedusaRequest<{ code?: string }>,
    res: MedusaResponse
) {
    const { code } = req.body
    if (!code || code.trim().length < 6) {
        return res.status(400).json({ error: 'code must be at least 6 characters' })
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()
        await client.query(`
            UPDATE store
            SET metadata = COALESCE(metadata, '{}') || $1::jsonb
        `, [JSON.stringify({ admin_override_pass: code.trim() })])
        return res.json({ success: true })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    } finally {
        await client.end()
    }
}
