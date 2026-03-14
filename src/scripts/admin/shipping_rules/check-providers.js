const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Registered fulfillment providers:');
    const providers = await client.query(`
    SELECT id, is_enabled 
    FROM fulfillment_provider 
    ORDER BY id
  `);
    console.table(providers.rows);

    console.log('\n📊 Shipping options and their providers:');
    const options = await client.query(`
    SELECT 
      so.id,
      so.name,
      so.provider_id,
      CASE 
        WHEN fp.id IS NOT NULL THEN '✅ EXISTS'
        ELSE '❌ MISSING'
      END as provider_status
    FROM shipping_option so
    LEFT JOIN fulfillment_provider fp ON so.provider_id = fp.id
    ORDER BY so.name
  `);
    console.table(options.rows);

    await client.end();
})();
