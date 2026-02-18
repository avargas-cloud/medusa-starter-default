const { Client } = require('pg');
const { randomUUID } = require('crypto');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Checking for existing shipping_option_price entries:\n');

    const existing = await client.query(`
    SELECT sop.*, so.name as option_name
    FROM shipping_option_price sop
    JOIN shipping_option so ON sop.shipping_option_id = so.id
    ORDER BY so.name
  `);

    console.table(existing.rows);

    console.log('\n🔧 Creating shipping_option_price entries for calculated options...\n');

    // Get all shipping options with calculated price_type that don't have prices
    const optionsNeedingPrices = await client.query(`
    SELECT so.id, so.name
    FROM shipping_option so
    LEFT JOIN shipping_option_price sop ON so.id = sop.shipping_option_id
    WHERE so.price_type = 'calculated'
    AND sop.id IS NULL
    ORDER BY so.name
  `);

    if (optionsNeedingPrices.rows.length === 0) {
        console.log('✅ All calculated shipping options already have prices!');
    } else {
        console.log(`Found ${optionsNeedingPrices.rows.length} options needing prices:\n`);

        for (const option of optionsNeedingPrices.rows) {
            const priceId = `soprice_${randomUUID().replace(/-/g, '').substring(0, 26)}`;

            await client.query(`
        INSERT INTO shipping_option_price (
          id,
          shipping_option_id,
          currency_code,
          amount,
          created_at,
          updated_at
        ) VALUES ($1, $2, 'usd', 0, NOW(), NOW())
      `, [priceId, option.id]);

            console.log(`✅ Created price entry for: ${option.name}`);
        }
    }

    console.log('\n📊 Final shipping_option_price entries:\n');
    const final = await client.query(`
    SELECT sop.*, so.name as option_name
    FROM shipping_option_price sop
    JOIN shipping_option so ON sop.shipping_option_id = so.id
    ORDER BY so.name
  `);
    console.table(final.rows);

    await client.end();
    console.log('\n✅ Done! Refresh the checkout to see if prices now calculate.');
})();
