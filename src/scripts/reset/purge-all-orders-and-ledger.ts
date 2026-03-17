import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const REDIS_URL = process.env.REDIS_URL

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    console.log(`\n🧹 Nuclear Purge: ALL Orders & Ledger Transactions \n`)

    await client.query("BEGIN")

    try {
        console.log("1. Deleting Customer Finance Ledger (payment_application, invoice_payment, customer_payment)")
        await client.query(`DELETE FROM payment_application`)
        await client.query(`DELETE FROM invoice_payment`)
        await client.query(`DELETE FROM customer_payment`)

        console.log("2. Deleting POS Invoices (invoice_tracking, pos_invoice_item, pos_invoice)")
        await client.query(`DELETE FROM invoice_tracking`)
        await client.query(`DELETE FROM pos_invoice_item`)
        await client.query(`DELETE FROM pos_invoice`)

        console.log("3. Deleting All Non-Draft Orders and Related Records...")
        
        // Target all NON-draft orders
        const ordersResult = await client.query(`
            SELECT id FROM "order" WHERE is_draft_order = false
        `)
        const orderIds = ordersResult.rows.map(o => o.id)

        if (orderIds.length > 0) {
            console.log(`   Found ${orderIds.length} non-draft orders. Nuking...`)

            // payment_collection
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

            // Addresses
            const addressResult = await client.query(`
                SELECT DISTINCT unnest(ARRAY[shipping_address_id, billing_address_id]) AS addr_id
                FROM "order" WHERE id = ANY($1::text[]) AND (shipping_address_id IS NOT NULL OR billing_address_id IS NOT NULL)
            `, [orderIds])
            const addressIds = addressResult.rows.map(r => r.addr_id).filter(Boolean)

            // The big one (Cascades order_change, order_item, shipping, etc)
            await client.query(`DELETE FROM "order" WHERE id = ANY($1::text[])`, [orderIds])

            if (addressIds.length > 0) {
                await client.query(`DELETE FROM order_address WHERE id = ANY($1::text[])`, [addressIds])
            }
        } else {
            console.log("   No non-draft orders found to delete.")
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
