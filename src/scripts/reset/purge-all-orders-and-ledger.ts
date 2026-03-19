import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const REDIS_URL = process.env.REDIS_URL

const INCLUDE_DRAFTS = process.argv.includes('--include-drafts')

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    console.log(`\n🧹 Nuclear Purge: Invoices, Payments & ${INCLUDE_DRAFTS ? 'ALL' : 'Confirmed'} Orders\n`)
    if (INCLUDE_DRAFTS) console.log('   ⚠️  --include-drafts: Draft/POS orders WILL be deleted')
    else console.log('   ℹ️  Draft/POS orders will be KEPT (pass --include-drafts to delete them)\n')

    await client.query("BEGIN")

    try {
        // ── Step 1: Custom Finance Ledger ────────────────────────────────────
        console.log("1. Deleting Customer Finance Ledger (payment_application, invoice_payment, customer_payment)")
        await client.query(`DELETE FROM payment_application`)
        await client.query(`DELETE FROM invoice_payment`)
        await client.query(`DELETE FROM customer_payment`)

        // ── Step 2: POS Invoices ─────────────────────────────────────────────
        console.log("2. Deleting POS Invoices (invoice_tracking, pos_invoice_item, pos_invoice)")
        await client.query(`DELETE FROM invoice_tracking`)
        await client.query(`DELETE FROM pos_invoice_item`)
        await client.query(`DELETE FROM pos_invoice`)

        // ── Step 3: Fulfillments ─────────────────────────────────────────────
        console.log("3. Deleting Fulfillments (fulfillment_label, fulfillment_item, order_fulfillment, fulfillment)")
        await client.query("SAVEPOINT pre_fulfillments")
        try {
            await client.query(`DELETE FROM fulfillment_label`)
            await client.query(`DELETE FROM fulfillment_item`)
            await client.query(`DELETE FROM order_fulfillment`)
            await client.query(`DELETE FROM fulfillment`)
            await client.query("RELEASE SAVEPOINT pre_fulfillments")
        } catch (e) {
            await client.query("ROLLBACK TO pre_fulfillments")
            console.warn("   ⚠ Fulfillments logic skipped (tables may not exist)")
        }

        // ── Step 4: Item Allocations (Inventory Reservations) ───────────────
        console.log("4. Deleting Item Allocations / Reservations (reservation_item)")
        await client.query("SAVEPOINT pre_reservations")
        try {
            await client.query(`DELETE FROM reservation_item`)
            await client.query("RELEASE SAVEPOINT pre_reservations")
        } catch (e) {
            await client.query("ROLLBACK TO pre_reservations")
            console.warn("   ⚠ reservation_item not found, skipping")
        }

        // ── Step 5: ALL Orders (draft + non-draft) ───────────────────────────
        // NOTE: POS orders are is_draft_order = true — old script missed them!
        const orderFilter = INCLUDE_DRAFTS ? '' : 'WHERE is_draft_order = false'
        console.log(`5. Deleting ${INCLUDE_DRAFTS ? 'ALL' : 'Confirmed'} Orders and Related Records...`)

        const ordersResult = await client.query(`SELECT id FROM "order" ${orderFilter}`)
        const orderIds = ordersResult.rows.map(o => o.id)

        if (orderIds.length > 0) {
            console.log(`   Found ${orderIds.length} orders. Nuking...`)

            // Payment collections (captured payments, sessions)
            const payColResult = await client.query(`
                SELECT DISTINCT payment_collection_id FROM order_payment_collection WHERE order_id = ANY($1::text[])
            `, [orderIds])
            const payColIds = payColResult.rows.map(r => r.payment_collection_id)

            if (payColIds.length > 0) {
                await client.query(`DELETE FROM payment_session WHERE payment_collection_id = ANY($1::text[])`, [payColIds])
                await client.query(`DELETE FROM payment WHERE payment_collection_id = ANY($1::text[])`, [payColIds])
                await client.query(`DELETE FROM order_payment_collection WHERE order_id = ANY($1::text[])`, [orderIds])
                await client.query(`DELETE FROM payment_collection WHERE id = ANY($1::text[])`, [payColIds])
            }

            // Addresses (collect before deleting order)
            const addressResult = await client.query(`
                SELECT DISTINCT unnest(ARRAY[shipping_address_id, billing_address_id]) AS addr_id
                FROM "order" WHERE id = ANY($1::text[]) AND (shipping_address_id IS NOT NULL OR billing_address_id IS NOT NULL)
            `, [orderIds])
            const addressIds = addressResult.rows.map(r => r.addr_id).filter(Boolean)

            // Delete orders (cascades order_change, order_item, shipping_methods, etc.)
            await client.query(`DELETE FROM "order" WHERE id = ANY($1::text[])`, [orderIds])
            console.log(`   ✓ Deleted ${orderIds.length} orders`)

            if (addressIds.length > 0) {
                await client.query(`DELETE FROM order_address WHERE id = ANY($1::text[])`, [addressIds])
                console.log(`   ✓ Deleted ${addressIds.length} order addresses`)
            }
        } else {
            console.log("   No orders found to delete.")
        }

        // ── Step 6: Draft Orders table (if separate in this Medusa version) ─
        const draftCheck = await client.query(`
            SELECT table_name FROM information_schema.tables WHERE table_name = 'draft_order'
        `)
        if (draftCheck.rows.length > 0) {
            console.log("6. Deleting draft_order records")
            await client.query(`DELETE FROM draft_order`)
        }

        await client.query("COMMIT")
        console.log("\n✅ Database Purged Successfully.\n")

    } catch (err) {
        await client.query("ROLLBACK")
        console.error("\n❌ Error during deletion — ROLLED BACK:", (err as Error).message)
        await client.end()
        process.exit(1)
    }

    await client.end()

    // ── Flush Redis (workflow engine state) ──────────────────────────────────
    if (REDIS_URL) {
        console.log("🔴 Flushing Redis cache...")
        try {
            const { default: Redis } = await import("ioredis") as any
            const redis = new Redis(REDIS_URL, { connectTimeout: 8000, commandTimeout: 8000, lazyConnect: true })
            await redis.connect()
            await redis.flushall()
            await redis.quit()
            console.log("✅ Redis flushed")
        } catch (e) {
            console.warn("⚠️  Redis flush failed:", (e as Error).message)
        }
    }
}

main().catch((err) => {
    console.error("❌ Fatal:", err.message)
    process.exit(1)
})
