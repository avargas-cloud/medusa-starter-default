const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    const stockLocationId = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';

    console.log('🔧 Updating location_fulfillment_provider entries to use new provider IDs...\n');

    // Update UPS Next Day Air
    await client.query(`
    UPDATE location_fulfillment_provider 
    SET fulfillment_provider_id = 'ups-next-day-air_ups-next-day-air'
    WHERE stock_location_id = $1 
    AND fulfillment_provider_id = 'custom-fulfillment_ups-next-day-air'
  `, [stockLocationId]);
    console.log('✅ Updated UPS Next Day Air');

    // Update UPS 2nd Day Air
    await client.query(`
    UPDATE location_fulfillment_provider 
    SET fulfillment_provider_id = 'ups-2nd-day-air_ups-2nd-day-air'
    WHERE stock_location_id = $1 
    AND fulfillment_provider_id = 'custom-fulfillment_ups-2nd-day-air'
  `, [stockLocationId]);
    console.log('✅ Updated UPS 2nd Day Air');

    // Update UPS 3 Day Select
    await client.query(`
    UPDATE location_fulfillment_provider 
    SET fulfillment_provider_id = 'ups-3-day-select_ups-3-day-select'
    WHERE stock_location_id = $1 
    AND fulfillment_provider_id = 'custom-fulfillment_ups-3-day-select'
  `, [stockLocationId]);
    console.log('✅ Updated UPS 3 Day Select');

    // Update Ground Shipping
    await client.query(`
    UPDATE location_fulfillment_provider 
    SET fulfillment_provider_id = 'ground-shipping_ground-shipping'
    WHERE stock_location_id = $1 
    AND fulfillment_provider_id = 'custom-fulfillment_ground-shipping'
  `, [stockLocationId]);
    console.log('✅ Updated Ground Shipping');

    // Update Store Pickup
    await client.query(`
    UPDATE location_fulfillment_provider 
    SET fulfillment_provider_id = 'store-pickup_store-pickup'
    WHERE stock_location_id = $1 
    AND fulfillment_provider_id = 'custom-fulfillment_store-pickup'
  `, [stockLocationId]);
    console.log('✅ Updated Store Pickup');

    console.log('\n📊 Final location_fulfillment_provider entries:');
    const final = await client.query(`
    SELECT 
      lfp.stock_location_id,
      lfp.fulfillment_provider_id,
      fp.is_enabled as provider_is_enabled
    FROM location_fulfillment_provider lfp
    JOIN fulfillment_provider fp ON lfp.fulfillment_provider_id = fp.id
    WHERE lfp.stock_location_id = $1
    AND lfp.deleted_at IS NULL
    ORDER BY lfp.fulfillment_provider_id
  `, [stockLocationId]);
    console.table(final.rows);

    await client.end();
    console.log('\n✅ Done! Now try saving the shipping option in the Admin.');
})();
