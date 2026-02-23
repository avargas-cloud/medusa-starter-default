import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

async function findAndCleanOrphans() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database');

        console.log('\n🔍 Scanning for orphaned auth identities (where no active customer exists for the email)...\n');

        // Find auth_identities where the email does not exist in the customer table
        const orphansRes = await client.query(`
            SELECT 
                ai.id as auth_identity_id, 
                ai.app_metadata->>'email' as email,
                pi.provider,
                pi.id as provider_identity_id
            FROM auth_identity ai
            LEFT JOIN provider_identity pi ON pi.auth_identity_id = ai.id
            WHERE ai.app_metadata->>'email' IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM customer c 
                WHERE c.email = ai.app_metadata->>'email' 
                AND c.deleted_at IS NULL
            )
        `);

        if (orphansRes.rows.length === 0) {
            console.log('✅ Excellent! No orphaned auth identities found in the database. Everything is clean.');
            return;
        }

        console.log(`⚠️ Found ${orphansRes.rows.length} orphaned provider/auth identities!`);
        console.log('Here are the ghost records:');
        console.table(orphansRes.rows);

        console.log('\n🧹 Cleaning up orphaned provider identities...');
        const providerIds = orphansRes.rows.map(r => r.provider_identity_id).filter(Boolean);
        if (providerIds.length > 0) {
            const deleteProviders = await client.query(`
                DELETE FROM provider_identity WHERE id = ANY($1) RETURNING id
            `, [providerIds]);
            console.log(`✅ Deleted ${deleteProviders.rowCount} provider_identity records.`);
        }

        console.log('\n🧹 Cleaning up orphaned auth identities...');
        const authIds = [...new Set(orphansRes.rows.map(r => r.auth_identity_id))];
        if (authIds.length > 0) {
            const deleteAuths = await client.query(`
                DELETE FROM auth_identity WHERE id = ANY($1) RETURNING id
            `, [authIds]);
            console.log(`✅ Deleted ${deleteAuths.rowCount} auth_identity records.`);
        }

        console.log('\n🎉 Finished cleaning up all orphaned identities!');

    } catch (e) {
        console.error('❌ Error during cleanup:', e);
    } finally {
        await client.end();
    }
}

findAndCleanOrphans();
