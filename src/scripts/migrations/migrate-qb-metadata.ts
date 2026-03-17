#!/usr/bin/env tsx
/**
 * migrate-qb-metadata.ts
 *
 * Migrates existing Medusa orders from flat QB metadata fields to the new
 * structured JSON format:
 *
 *   OLD (flat fields):
 *     qb_estimate_txn_id, qb_estimate_ref
 *     qb_sales_order_txn_id, qb_sales_order_ref, qb_sales_order_operation_id
 *     qb_invoice_txn_id, qb_invoice_ref, qb_invoice_operation_id
 *     qb_payment_txn_id, qb_payment_ref, qb_payment_operation_id
 *
 *   NEW (structured JSON):
 *     qb_estimate:    { ref_number, txn_id, operation_id, synced_at }
 *     qb_sales_order: { ref_number, txn_id, operation_id, synced_at }
 *     qb_invoices:    [{ ref_number, txn_id, operation_id, fulfillment_id, synced_at }]
 *     qb_payments:    [{ ref_number, txn_id, operation_id, amount, method, synced_at }]
 *
 * Safety:
 *   - Skips orders that already have qb_sales_order (new format) or qb_estimate (new format)
 *   - Set DRY_RUN=true to print what would change without touching the DB
 *   - Old flat fields are removed after migration (schema cleanup)
 *
 * Usage:
 *   DRY_RUN=true npx tsx src/scripts/migrations/migrate-qb-metadata.ts
 *   npx tsx src/scripts/migrations/migrate-qb-metadata.ts
 */

import { Client } from "pg"

const DRY_RUN = process.env.DRY_RUN === "true"
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
    console.error("❌  DATABASE_URL env var is required")
    process.exit(1)
}

// The old flat field names we are migrating away from
const OLD_FLAT_FIELDS = [
    "qb_estimate_txn_id",
    "qb_estimate_ref",
    "qb_sales_order_txn_id",
    "qb_sales_order_ref",
    "qb_sales_order_operation_id",
    "qb_invoice_txn_id",
    "qb_invoice_ref",
    "qb_invoice_operation_id",
    "qb_payment_txn_id",
    "qb_payment_ref",
    "qb_payment_operation_id",
]

interface OrderRow {
    id: string
    display_id: number
    metadata: Record<string, any>
}

function needsMigration(meta: Record<string, any>): boolean {
    // Already migrated if new shape already present for both SO and estimate
    const hasNewSo  = meta.qb_sales_order && typeof meta.qb_sales_order === "object" && meta.qb_sales_order.txn_id
    const hasNewEst = meta.qb_estimate    && typeof meta.qb_estimate === "object"     && meta.qb_estimate.txn_id
    const hasOldSo  = !!meta.qb_sales_order_txn_id
    const hasOldEst = !!meta.qb_estimate_txn_id
    const hasOldInv = !!meta.qb_invoice_txn_id
    const hasOldPay = !!meta.qb_payment_txn_id

    // Skip if new shape already set (both SO and estimate already migrated)
    if (hasNewSo && (hasOldEst ? hasNewEst : true)) return false

    // Migrate if any old field is present
    return hasOldSo || hasOldEst || hasOldInv || hasOldPay
}

function buildNewMetadata(meta: Record<string, any>): Record<string, any> {
    const now = meta.qb_synced_at || new Date().toISOString()
    const newMeta = { ...meta }

    // ── Estimate → qb_estimate ───────────────────────────────────────────────
    if (meta.qb_estimate_txn_id && !(meta.qb_estimate && typeof meta.qb_estimate === "object")) {
        newMeta.qb_estimate = {
            txn_id:       meta.qb_estimate_txn_id,
            ref_number:   meta.qb_estimate_ref || meta.qb_estimate_txn_id,
            operation_id: null,
            synced_at:    now,
        }
    }

    // ── Sales Order → qb_sales_order ─────────────────────────────────────────
    if (meta.qb_sales_order_txn_id && !(meta.qb_sales_order && typeof meta.qb_sales_order === "object")) {
        newMeta.qb_sales_order = {
            txn_id:       meta.qb_sales_order_txn_id,
            ref_number:   meta.qb_sales_order_ref || meta.qb_sales_order_txn_id,
            operation_id: meta.qb_sales_order_operation_id || null,
            synced_at:    now,
        }
        // Infer sync status if not already set
        if (!newMeta.qb_sync_status) {
            newMeta.qb_sync_status = meta.qb_estimate_txn_id
                ? "estimate_conversion"
                : "sales_order"
        }
    }

    // ── Invoice → qb_invoices ─────────────────────────────────────────────────
    if (meta.qb_invoice_txn_id && !Array.isArray(meta.qb_invoices)) {
        newMeta.qb_invoices = [{
            txn_id:         meta.qb_invoice_txn_id,
            ref_number:     meta.qb_invoice_ref || meta.qb_invoice_txn_id,
            operation_id:   meta.qb_invoice_operation_id || null,
            fulfillment_id: null,   // unknown for legacy records
            synced_at:      now,
        }]
    }

    // ── Payment → qb_payments ─────────────────────────────────────────────────
    if (meta.qb_payment_txn_id && !Array.isArray(meta.qb_payments)) {
        newMeta.qb_payments = [{
            txn_id:       meta.qb_payment_txn_id,
            ref_number:   meta.qb_payment_ref || null,
            operation_id: meta.qb_payment_operation_id || null,
            amount:        0,       // unknown for legacy records
            method:        "unknown",
            synced_at:     now,
        }]
    }

    // ── Remove old flat fields ────────────────────────────────────────────────
    for (const field of OLD_FLAT_FIELDS) {
        delete newMeta[field]
    }

    return newMeta
}

async function main() {
    console.log(`\n🔄  QB Metadata Migration ${DRY_RUN ? "[DRY RUN — no DB writes]" : "[LIVE RUN]"}`)
    console.log("─".repeat(60))

    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()

    try {
        // Fetch all orders (and draft orders, which share the same table) that have any old flat field
        const whereClause = OLD_FLAT_FIELDS
            .map(f => `metadata ? '${f}'`)
            .join(" OR ")

        const result = await client.query<OrderRow>(
            `SELECT id, display_id, metadata FROM "order" WHERE ${whereClause} ORDER BY display_id ASC`
        )

        console.log(`Found ${result.rows.length} orders with old flat QB metadata fields\n`)

        let migrated = 0
        let skipped  = 0

        for (const row of result.rows) {
            const meta = row.metadata as Record<string, any>

            if (!needsMigration(meta)) {
                console.log(`  ⏭️  Order #${row.display_id} (${row.id}) — already migrated, skipping`)
                skipped++
                continue
            }

            const newMeta = buildNewMetadata(meta)

            console.log(`\n  ✅  Order #${row.display_id} (${row.id})`)
            if (meta.qb_estimate_txn_id) {
                console.log(`     estimate:    ${meta.qb_estimate_txn_id} → qb_estimate.txn_id`)
            }
            if (meta.qb_sales_order_txn_id) {
                console.log(`     sales order: ${meta.qb_sales_order_txn_id} → qb_sales_order.txn_id`)
            }
            if (meta.qb_invoice_txn_id) {
                console.log(`     invoice:     ${meta.qb_invoice_txn_id} → qb_invoices[0].txn_id`)
            }
            if (meta.qb_payment_txn_id) {
                console.log(`     payment:     ${meta.qb_payment_txn_id} → qb_payments[0].txn_id`)
            }

            if (!DRY_RUN) {
                await client.query(
                    `UPDATE "order" SET metadata = $1 WHERE id = $2`,
                    [JSON.stringify(newMeta), row.id]
                )
            }

            migrated++
        }

        console.log("\n" + "─".repeat(60))
        console.log(`🏁  Done — ${migrated} migrated, ${skipped} already up-to-date`)
        if (DRY_RUN) {
            console.log("    ℹ️  Dry run: no changes written to DB. Remove DRY_RUN=true to apply.")
        }

    } finally {
        await client.end()
    }
}

main().catch(err => {
    console.error("❌  Migration failed:", err)
    process.exit(1)
})
