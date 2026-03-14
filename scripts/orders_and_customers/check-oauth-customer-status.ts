#!/usr/bin/env tsx
/**
 * check-oauth-customer-status.ts
 * Checks OAuth/auth_identity link and has_account status for a given email.
 */
import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const EMAIL = process.argv[2] || 'a.vargas@ecopowertech.com';
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
    await client.connect();
    console.log(`\n🔍 Checking OAuth status for: ${EMAIL}\n`);

    // 1. Customer + has_account + groups
    const custResult = await client.query(`
    SELECT c.id, c.email, c.has_account, c.first_name, c.last_name,
           string_agg(cg.name, ', ') as customer_groups
    FROM customer c
    LEFT JOIN customer_group_customers cgc ON c.id = cgc.customer_id
    LEFT JOIN customer_group cg ON cgc.customer_group_id = cg.id
    WHERE c.email = $1
    GROUP BY c.id, c.email, c.has_account, c.first_name, c.last_name
  `, [EMAIL]);
    console.log('=== CUSTOMER STATUS ===');
    console.table(custResult.rows);

    if (custResult.rows.length === 0) {
        console.log('❌ No customer found with that email.');
        return;
    }

    const customerId = custResult.rows[0].id;
    const hasAccount = custResult.rows[0].has_account;
    console.log(`\n📌 has_account: ${hasAccount} ${hasAccount ? '✅ Registered' : '❌ Guest (this is the problem!)'}`);

    // 2. Auth identity / provider_identity link
    const authResult = await client.query(`
    SELECT 
      ai.id as auth_identity_id,
      pi2.provider,
      pi2.entity_id,
      pi2.user_metadata->>'email' as pi_email,
      cah.actor_id as linked_customer_id
    FROM auth_identity ai
    JOIN provider_identity pi2 ON pi2.auth_identity_id = ai.id
    LEFT JOIN customer_account_holder cah ON cah.auth_identity_id = ai.id
    WHERE pi2.user_metadata->>'email' = $1
       OR pi2.entity_id ILIKE $1
  `, [EMAIL]);
    console.log('\n=== AUTH IDENTITY / PROVIDER IDENTITY ===');
    console.table(authResult.rows);

    if (authResult.rows.length > 0) {
        const linkedId = authResult.rows[0].linked_customer_id;
        if (linkedId !== customerId) {
            console.log(`\n⚠️  Auth identity links to DIFFERENT customer: ${linkedId}`);
            console.log(`   Expected: ${customerId}`);
        } else {
            console.log(`\n✅ Auth identity correctly linked to customer: ${customerId}`);
        }
    } else {
        console.log('\n❌ No auth_identity found for this email (no Google login linked yet)');
    }

    await client.end();
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
