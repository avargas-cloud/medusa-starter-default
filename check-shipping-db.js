const { Client } = require('pg');

async function checkShippingData() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // 1. Check shipping_settings
        console.log('📋 SHIPPING SETTINGS:');
        console.log('='.repeat(80));
        const settings = await client.query('SELECT * FROM shipping_settings LIMIT 1');
        if (settings.rows.length > 0) {
            console.log(JSON.stringify(settings.rows[0], null, 2));
        } else {
            console.log('⚠️  No shipping settings found');
        }

        // 2. Check shipping_option table
        console.log('\n📦 SHIPPING OPTIONS:');
        console.log('='.repeat(80));
        const options = await client.query(`
            SELECT id, name, provider_id, price_type, amount, data
            FROM shipping_option
            ORDER BY name
            LIMIT 20
        `);

        console.log(`Found ${options.rows.length} shipping options:\n`);
        options.rows.forEach((opt, idx) => {
            console.log(`${idx + 1}. ${opt.name}`);
            console.log(`   ID: ${opt.id}`);
            console.log(`   Provider: ${opt.provider_id}`);
            console.log(`   Price Type: ${opt.price_type}`);
            console.log(`   Amount: ${opt.amount || 'NULL'}`);
            console.log(`   Data: ${JSON.stringify(opt.data)}`);
            console.log('');
        });

        // 3. Check fulfillment_provider table
        console.log('\n🚚 FULFILLMENT PROVIDERS:');
        console.log('='.repeat(80));
        const providers = await client.query(`
            SELECT id, is_enabled
            FROM fulfillment_provider
            ORDER BY id
        `);

        console.log(`Found ${providers.rows.length} providers:\n`);
        providers.rows.forEach((prov, idx) => {
            console.log(`${idx + 1}. ${prov.id} - Enabled: ${prov.is_enabled}`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
        console.log('\n✅ Database connection closed');
    }
}

checkShippingData();
