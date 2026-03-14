import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false,
    });

    try {
        await client.connect();

        console.log("--- cart_line_item SAMPLE ---");
        const cartRes = await client.query('SELECT id, unit_price, raw_unit_price, quantity, raw_quantity FROM cart_line_item LIMIT 1');
        console.log("Valid Cart Item:", JSON.stringify(cartRes.rows[0], null, 2));

        console.log("\n--- order_item ORDER 1056 ---");
        const orderRes = await client.query('SELECT oi.id, oi.unit_price, oi.raw_unit_price, oi.quantity, oi.raw_quantity FROM order_item oi JOIN "order" o ON oi.order_id = o.id WHERE o.display_id = 1056');
        console.log("Order 1056 Item:", JSON.stringify(orderRes.rows[0], null, 2));

    } catch (error) {
        console.error("DB Error:", error);
    } finally {
        await client.end();
    }
}

run();
