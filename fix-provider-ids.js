const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Current shipping options:');
    const current = await client.query(`
    SELECT id, name, provider_id 
    FROM shipping_option 
    ORDER BY name
  `);
    console.table(current.rows);

    console.log('\n🔧 Updating provider_ids to match module identifiers...');

    // Update UPS Next Day Air
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-next-day-air'
    WHERE provider_id = 'custom-fulfillment_ups-next-day-air'
  `);

    // Update UPS 2nd Day Air
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-2nd-day-air'
    WHERE provider_id = 'custom-fulfillment_ups-2nd-day-air'
  `);

    // Update UPS 3 Day Select
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-3-day-select'
    WHERE provider_id = 'custom-fulfillment_ups-3-day-select'
  `);

    // Update Ground Shipping
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ground-shipping'
    WHERE provider_id = 'custom-fulfillment_ground-shipping'
  `);

    // Update Store Pickup
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'store-pickup'
    WHERE provider_id = 'custom-fulfillment_store-pickup'
  `);

    console.log('✅ Updated provider_ids');

    console.log('\n📊 New configuration:');
    const after = await client.query(`
    SELECT id, name, provider_id 
    FROM shipping_option 
    ORDER BY name
  `);
    console.table(after.rows);

    await client.end();
    console.log('\n✅ Done! Restart the backend for changes to take effect.');
})();
