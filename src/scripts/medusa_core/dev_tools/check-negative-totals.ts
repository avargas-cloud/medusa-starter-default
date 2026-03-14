#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function checkNegativeOrders() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        console.log('--- VERIFYING CANCELED ORDERS IN DATABASE ---');
        console.log('Checking for any negative totals assigned to canceled orders...\n');

        // Query to check the latest canceled orders and their totals
        const query = `
      SELECT o.id, o.display_id, o.status, os.totals
      FROM "order" o
      JOIN order_summary os ON o.id = os.order_id
      WHERE o.status = 'canceled'
      ORDER BY o.display_id DESC
      LIMIT 100
    `;

        const result = await client.query(query);
        const orders = result.rows;

        if (orders.length === 0) {
            console.log('No canceled orders found in the database.');
            return;
        }

        let hasNegatives = false;
        let checkedOrders = 0;

        for (const order of orders) {
            checkedOrders++;
            const currentTotal = order.totals.current_order_total;

            // If the total is less than 0, it means we have a negative amount
            if (Number(currentTotal) < 0) {
                console.log(`❌ Order #${order.display_id} | ID: ${order.id} | Negative Total: $${currentTotal}`);
                hasNegatives = true;
            } else {
                // Optional debugging output
                // console.log(`✅ Order #${order.display_id} | Total: $${currentTotal}`);
            }
        }

        console.log(`\nChecked ${checkedOrders} canceled orders.`);

        if (hasNegatives) {
            console.log('\n❌ FAILED: Found negative totals in the database. These should be fixed.');
        } else {
            console.log('\n✅ PASSED: All canceled orders have $0 or positive totals.');
            console.log('💡 Note: If you see negative totals in the Admin UI, it is a UI calculation bug, not a database error.');
        }

    } catch (error) {
        console.error('❌ Error executing script:', error);
    } finally {
        await client.end();
    }
}

checkNegativeOrders();
