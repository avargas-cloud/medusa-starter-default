const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Current shipping_option configuration:\n');
    const options = await client.query(`
    SELECT 
      id,
      name,
      provider_id,
      price_type,
      amount
    FROM shipping_option
    ORDER BY name
  `);
    console.table(options.rows);

    await client.end();
})();
