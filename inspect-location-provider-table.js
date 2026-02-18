const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Checking location_fulfillment_provider table structure:\n');

    const columns = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'location_fulfillment_provider'
    ORDER BY ordinal_position
  `);

    console.log('Columns:');
    console.table(columns.rows);

    console.log('\n📊 Current entries in location_fulfillment_provider:\n');
    const entries = await client.query(`SELECT * FROM location_fulfillment_provider LIMIT 20`);
    console.table(entries.rows);

    await client.end();
})();
