const { Client } = require('pg');

async function addLegacyFlag() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        console.log('📝 Adding legacy_customer flag to all guest customers with QuickBooks ID...\n');

        const result = await client.query(`
            UPDATE customer
            SET metadata = metadata || '{"legacy_customer": true}'::jsonb
            WHERE has_account = false
              AND metadata->>'qb_list_id' IS NOT NULL;
        `);

        console.log(`✅ Updated ${result.rowCount} customers with legacy_customer flag\n`);

        // Verify
        const verifyResult = await client.query(`
            SELECT 
                COUNT(*) as total_with_flag,
                COUNT(CASE WHEN metadata->>'legacy_customer' = 'true' THEN 1 END) as flagged
            FROM customer
            WHERE has_account = false
              AND metadata->>'qb_list_id' IS NOT NULL;
        `);

        console.log('📊 Verification:');
        console.log(`Total guest customers: ${verifyResult.rows[0].total_with_flag}`);
        console.log(`With legacy_customer flag: ${verifyResult.rows[0].flagged}\n`);

        // Sample customer
        const sampleResult = await client.query(`
            SELECT email, first_name, last_name, metadata
            FROM customer
            WHERE has_account = false
              AND metadata->>'qb_list_id' IS NOT NULL
            LIMIT 1
        `);

        console.log('📋 Sample customer with flag:');
        console.log(`Email: ${sampleResult.rows[0].email}`);
        console.log(`Metadata:`, JSON.stringify(sampleResult.rows[0].metadata, null, 2));

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

addLegacyFlag();
