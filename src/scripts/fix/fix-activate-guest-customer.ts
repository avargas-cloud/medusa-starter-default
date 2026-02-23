#!/usr/bin/env tsx
/**
 * fix-activate-guest-customer.ts
 * Manually activates a legacy/guest customer to 'registered' status.
 * Use when the customer already exists in DB but hasn't gone through
 * the Google OAuth activation flow yet.
 * 
 * Usage: npx -y tsx src/scripts/fix/fix-activate-guest-customer.ts <email>
 */
import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const EMAIL = process.argv[2];
if (!EMAIL) {
    console.error('❌ Usage: npx -y tsx src/scripts/fix/fix-activate-guest-customer.ts <email>');
    process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
    await client.connect();
    console.log(`\n🔍 Looking for customer: ${EMAIL}\n`);

    // 1. Check current state
    const before = await client.query(`
        SELECT c.id, c.email, c.has_account, c.first_name, c.last_name,
               string_agg(cg.name, ', ') as customer_groups
        FROM customer c
        LEFT JOIN customer_group_customers cgc ON c.id = cgc.customer_id
        LEFT JOIN customer_group cg ON cgc.customer_group_id = cg.id
        WHERE c.email = $1
        GROUP BY c.id, c.email, c.has_account, c.first_name, c.last_name
    `, [EMAIL]);

    if (before.rows.length === 0) {
        console.error(`❌ No customer found with email: ${EMAIL}`);
        await client.end();
        process.exit(1);
    }

    const customer = before.rows[0];
    console.log('BEFORE:');
    console.table(before.rows);

    if (customer.has_account) {
        console.log(`\n✅ Customer already has_account=true. No action needed.\n`);
        await client.end();
        return;
    }

    // 2. Activate
    await client.query(`
        UPDATE customer
        SET has_account = true
        WHERE id = $1
    `, [customer.id]);

    // 3. Verify
    const after = await client.query(`
        SELECT c.id, c.email, c.has_account, c.first_name, c.last_name,
               string_agg(cg.name, ', ') as customer_groups
        FROM customer c
        LEFT JOIN customer_group_customers cgc ON c.id = cgc.customer_id
        LEFT JOIN customer_group cg ON cgc.customer_group_id = cg.id
        WHERE c.email = $1
        GROUP BY c.id, c.email, c.has_account, c.first_name, c.last_name
    `, [EMAIL]);

    console.log('\nAFTER:');
    console.table(after.rows);

    const activated = after.rows[0];
    if (activated.has_account) {
        console.log(`\n✅ Customer successfully activated!`);
        console.log(`   ID: ${activated.id}`);
        console.log(`   Groups: ${activated.customer_groups || 'none'}`);
        console.log(`\n→ Customer will now receive wholesale pricing when logged in.`);
        console.log(`→ They need to log in again via Google for the JWT to reflect the new status.`);
    } else {
        console.error(`\n❌ Activation failed — has_account is still false.`);
    }

    await client.end();
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
