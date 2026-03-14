const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Finding tables related to fulfillment providers...\n');

    // List all tables that contain 'fulfillment' or 'provider'
    const tables = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND (table_name LIKE '%fulfillment%' OR table_name LIKE '%provider%')
    ORDER BY table_name
  `);

    console.log('Tables:');
    console.table(tables.rows);

    await client.end();
})();
