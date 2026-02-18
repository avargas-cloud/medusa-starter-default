const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('🔧 Updating shipping options to use ENABLED providers...\n');

    // Update UPS Next Day Air
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-next-day-air_ups-next-day-air'
    WHERE provider_id = 'custom-fulfillment_ups-next-day-air'
  `);
    console.log('✅ Updated UPS Next Day Air');

    // Update UPS 2nd Day Air
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-2nd-day-air_ups-2nd-day-air'
    WHERE provider_id = 'custom-fulfillment_ups-2nd-day-air'
  `);
    console.log('✅ Updated UPS 2nd Day Air');

    // Update UPS 3 Day Select
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ups-3-day-select_ups-3-day-select'
    WHERE provider_id = 'custom-fulfillment_ups-3-day-select'
  `);
    console.log('✅ Updated UPS 3 Day Select');

    // Update Ground Shipping
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'ground-shipping_ground-shipping'
    WHERE provider_id = 'custom-fulfillment_ground-shipping'
  `);
    console.log('✅ Updated Ground Shipping');

    // Update Store Pickup
    await client.query(`
    UPDATE shipping_option 
    SET provider_id = 'store-pickup_store-pickup'
    WHERE provider_id = 'custom-fulfillment_store-pickup'
  `);
    console.log('✅ Updated Store Pickup');

    console.log('\n📊 Final configuration:');
    const final = await client.query(`
    SELECT 
      so.name,
      so.provider_id,
      fp.is_enabled
    FROM shipping_option so
    JOIN fulfillment_provider fp ON so.provider_id = fp.id
    ORDER BY so.name
  `);
    console.table(final.rows);

    await client.end();
    console.log('\n✅ Done! Now try saving the shipping option in the Admin.');
})();
