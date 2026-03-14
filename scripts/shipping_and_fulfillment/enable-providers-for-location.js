const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Current location_fulfillment_provider entries:\n');
    const current = await client.query(`
    SELECT * FROM location_fulfillment_provider
    ORDER BY stock_location_id, provider_id
  `);
    console.table(current.rows);

    // Get all stock locations
    const locations = await client.query(`
    SELECT id, name FROM stock_location ORDER BY name
  `);

    console.log('\n📍 Stock Locations:');
    console.table(locations.rows);

    // Get the main stock location (usually the first one)
    const stockLocationId = locations.rows[0]?.id;

    if (!stockLocationId) {
        console.error('❌ No stock location found!');
        await client.end();
        return;
    }

    console.log(`\n🔧 Enabling providers for stock location: ${stockLocationId}\n`);

    // Enable all the active providers for this stock location
    const providersToEnable = [
        'ups-next-day-air_ups-next-day-air',
        'ups-2nd-day-air_ups-2nd-day-air',
        'ups-3-day-select_ups-3-day-select',
        'ground-shipping_ground-shipping',
        'store-pickup_store-pickup'
    ];

    for (const providerId of providersToEnable) {
        // Check if already exists
        const existing = await client.query(`
      SELECT * FROM location_fulfillment_provider 
      WHERE stock_location_id = $1 AND provider_id = $2
    `, [stockLocationId, providerId]);

        if (existing.rows.length === 0) {
            // Insert the link
            await client.query(`
        INSERT INTO location_fulfillment_provider (stock_location_id, provider_id)
        VALUES ($1, $2)
      `, [stockLocationId, providerId]);
            console.log(`✅ Enabled provider: ${providerId}`);
        } else {
            console.log(`ℹ️  Provider already enabled: ${providerId}`);
        }
    }

    console.log('\n📊 Final location_fulfillment_provider entries:');
    const final = await client.query(`
    SELECT 
      lfp.stock_location_id,
      lfp.provider_id,
      fp.is_enabled as provider_is_enabled
    FROM location_fulfillment_provider lfp
    JOIN fulfillment_provider fp ON lfp.provider_id = fp.id
    WHERE lfp.stock_location_id = $1
    ORDER BY lfp.provider_id
  `, [stockLocationId]);
    console.table(final.rows);

    await client.end();
    console.log('\n✅ Done! Now try saving the shipping option in the Admin.');
})();
