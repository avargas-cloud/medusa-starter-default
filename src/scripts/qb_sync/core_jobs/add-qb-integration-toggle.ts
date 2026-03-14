/**
 * add-qb-integration-toggle.ts
 *
 * DB Migration: Adds integration_enabled column to quickbooks_config table.
 *
 * Run once:
 *   yarn medusa exec ./src/scripts/migrate/add-qb-integration-toggle.ts
 */

import { ExecArgs } from "@medusajs/framework/types"
import { Client } from "pg"

export default async function addQbIntegrationToggle({ }: ExecArgs) {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // Add integration_enabled column (safe — IF NOT EXISTS)
        await client.query(`
            ALTER TABLE quickbooks_config
            ADD COLUMN IF NOT EXISTS integration_enabled boolean NOT NULL DEFAULT true;
        `)

        console.log("✅ Migration complete: quickbooks_config.integration_enabled column added (default: true)")

        // Verify
        const result = await client.query(`
            SELECT id, integration_enabled FROM quickbooks_config WHERE id = 'default'
        `)
        console.log("Current QB config:", result.rows[0])

    } catch (error: any) {
        console.error("❌ Migration failed:", error.message)
        throw error
    } finally {
        await client.end()
    }
}
