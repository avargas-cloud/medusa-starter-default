const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 shipping_option table structure:\n');
    const columns = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'shipping_option'
    ORDER BY ordinal_position
  `);
    console.table(columns.rows);

    console.log('\n📊 Current shipping_option data:\n');
    const options = await client.query(`
    SELECT 
      id,
      name,
      provider_id,
      price_type
    FROM shipping_option
    ORDER BY name
  `);
    console.table(options.rows);

    await client.end();
})();
