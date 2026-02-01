const { Client } = require('pg');

async function checkColumn() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database');

        // Check if column exists
        const checkResult = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'quickbooks_config' 
            AND column_name = 'customer_interval_minutes'
        `);

        if (checkResult.rows.length > 0) {
            console.log('✅ Column customer_interval_minutes already exists');
        } else {
            console.log('❌ Column customer_interval_minutes does NOT exist');
            console.log('🔧 Creating column...');

            await client.query(`
                ALTER TABLE quickbooks_config 
                ADD COLUMN customer_interval_minutes INTEGER
            `);

            console.log('✅ Column created successfully!');
        }

        // Show all columns
        const columns = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'quickbooks_config'
            ORDER BY ordinal_position
        `);

        console.log('\n📋 Current columns in quickbooks_config:');
        columns.rows.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type}, nullable: ${col.is_nullable})`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkColumn();
