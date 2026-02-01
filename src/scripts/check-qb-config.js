const { Client } = require('pg');

async function checkConfig() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();

        const result = await client.query(`
            SELECT 
                inventory_interval_minutes,
                price_interval_minutes,
                customer_interval_minutes,
                created_at,
                updated_at
            FROM quickbooks_config
        `);

        console.log('\n📋 QuickBooks Config in Database:\n');
        if (result.rows.length > 0) {
            const config = result.rows[0];
            console.log('Inventory Interval:', config.inventory_interval_minutes === null ? 'NULL (disabled)' : `${config.inventory_interval_minutes} minutes`);
            console.log('Price Interval:    ', config.price_interval_minutes === null ? 'NULL (disabled)' : `${config.price_interval_minutes} minutes`);
            console.log('Customer Interval: ', config.customer_interval_minutes === null ? 'NULL (disabled)' : `${config.customer_interval_minutes} minutes`);
            console.log('\nLast Updated:', config.updated_at);
        } else {
            console.log('No config found');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkConfig();
