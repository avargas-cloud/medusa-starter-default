#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

dotenv.config({ path: resolve(__dirname, '../../../../.env') });

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    console.log("--- Latest POS Invoices ---");
    const invRes = await client.query(`
        SELECT id, invoice_number, status, total, metadata->>'qb_txn_id' as qb_txn_id, metadata->>'qb_ref_number' as qb_ref_number, created_at
        FROM pos_invoice 
        ORDER BY created_at DESC LIMIT 3
    `);
    console.table(invRes.rows);

    console.log("--- Latest Customer Payments ---");
    const payRes = await client.query(`
        SELECT id, amount, method, status, metadata->>'qb_txn_id' as qb_txn_id, created_at
        FROM customer_payment 
        ORDER BY created_at DESC LIMIT 3
    `);
    console.table(payRes.rows);

    console.log("--- Latest Payment Applications ---");
    const appRes = await client.query(`
        SELECT id, payment_id, invoice_id, amount_applied, created_at
        FROM payment_application 
        ORDER BY created_at DESC LIMIT 3
    `);
    console.table(appRes.rows);

    await client.end();
}
main();
