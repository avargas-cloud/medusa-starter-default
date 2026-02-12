const { Client } = require('pg');

async function cleanProviders() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        console.error('❌ DATABASE_URL not set');
        process.exit(1);
    }

    const client = new Client({ connectionString: databaseUrl });

    try {
        await client.connect();
        console.log('✅ Connected to database');

        const locationId = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';

        // Check current links
        const checkResult = await client.query(
            'SELECT * FROM location_fulfillment_provider WHERE stock_location_id = $1',
            [locationId]
        );

        console.log(`\n📋 Current providers for location: ${checkResult.rows.length}`);
        checkResult.rows.forEach(row => {
            console.log(`   - ${row.fulfillment_provider_id}`);
        });

        // Old provider IDs to DELETE
        const oldProviderIds = [
            'ground-shipping_ground-shipping',
            'store-pickup_store-pickup',
            'ups-shipping_ups-next-day-air',
            'ups-shipping_ups-2nd-day-air',
            'ups-shipping_ups-3-day-select'
        ];

        console.log(`\n🗑️  Deleting old duplicate providers...`);

        // Delete old duplicate providers
        let deleted = 0;
        for (const providerId of oldProviderIds) {
            const result = await client.query(
                `DELETE FROM location_fulfillment_provider 
         WHERE stock_location_id = $1 AND fulfillment_provider_id = $2 
         RETURNING *`,
                [locationId, providerId]
            );

            if (result.rowCount > 0) {
                console.log(`   ✅ Deleted: ${providerId}`);
                deleted++;
            }
        }

        console.log(`\n✨ Done! Removed ${deleted} old duplicate providers`);

        // Show final list
        const finalResult = await client.query(
            'SELECT * FROM location_fulfillment_provider WHERE stock_location_id = $1',
            [locationId]
        );

        console.log(`\n📋 Final providers for location: ${finalResult.rows.length}`);
        finalResult.rows.forEach(row => {
            console.log(`   - ${row.fulfillment_provider_id}`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

cleanProviders();
