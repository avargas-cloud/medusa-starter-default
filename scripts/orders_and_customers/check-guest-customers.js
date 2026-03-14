const { Client } = require('pg');

async function checkCustomerMetadata() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Count guest customers
        const countResult = await client.query(`
            SELECT 
                COUNT(*) as total_guests,
                COUNT(CASE WHEN metadata->>'qb_list_id' IS NOT NULL THEN 1 END) as with_qb_id
            FROM customer
            WHERE has_account = false
        `);

        console.log('📊 Guest Customer Summary:');
        console.log(`Total guest customers: ${countResult.rows[0].total_guests}`);
        console.log(`With QuickBooks ID: ${countResult.rows[0].with_qb_id}\n`);

        // Get sample customers
        const sampleResult = await client.query(`
            SELECT 
                id,
                email,
                first_name,
                last_name,
                has_account,
                metadata
            FROM customer
            WHERE has_account = false
            AND metadata->>'qb_list_id' IS NOT NULL
            LIMIT 3
        `);

        console.log('📋 Sample Guest Customers:\n');
        sampleResult.rows.forEach((customer, index) => {
            console.log(`Customer #${index + 1}:`);
            console.log(`  ID: ${customer.id}`);
            console.log(`  Email: ${customer.email}`);
            console.log(`  Name: ${customer.first_name} ${customer.last_name}`);
            console.log(`  has_account: ${customer.has_account}`);
            console.log(`  Metadata:`, JSON.stringify(customer.metadata, null, 2));
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkCustomerMetadata();
