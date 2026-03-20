import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    console.log(`\n🔍 Verifying Database Purge Status...`)
    let hasRecords = false;

    // List of tables to check
    const tables = [
        "order",
        "order_item",
        "order_shipping_method",
        "order_address",
        
        "pos_invoice",
        "pos_invoice_item",
        "invoice_tracking",
        
        "customer_payment",
        "payment_application",
        "invoice_payment",
        
        "fulfillment",
        "order_fulfillment",
        "fulfillment_item",
        "fulfillment_label",
        
        "reservation_item",
        
        "payment_collection",
        "payment_session",
        "payment"
    ]

    console.log("\nCounts by table:");
    for (const table of tables) {
        try {
            // Check if table exists first (some might be custom or skipped based on Medusa version)
            const check = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table.replace(/"/g, '')])
            if (check.rows.length === 0) {
                console.log(`- ${table.padEnd(25)}: (Table does not exist)`);
                continue;
            }

            const res = await client.query(`SELECT COUNT(*) as count FROM "${table.replace(/"/g, '')}"`);
            const count = parseInt(res.rows[0].count, 10);
            
            if (count > 0) {
                console.log(`❌ ${table.padEnd(24)}: ${count} records found!`);
                hasRecords = true;
            } else {
                console.log(`✅ ${table.padEnd(24)}: 0 records`);
            }
        } catch (e) {
            console.log(`⚠️ ${table.padEnd(24)}: Error checking - ${(e as Error).message}`);
        }
    }

    console.log("\n");
    if (hasRecords) {
        console.error("❌ PURGE INCOMPLETE: Some records still exist in the database.");
        process.exit(1);
    } else {
        console.log("✅ PURGE VERIFIED: All specified tables are completely empty.");
    }

    await client.end()
}

main().catch((err) => {
    console.error("❌ Fatal:", err.message)
    process.exit(1)
})
