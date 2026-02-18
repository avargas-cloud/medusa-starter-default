const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('📊 Checking shipping_option_rule table:\n');

    // Check if shipping_option_rule table exists
    const tableExists = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'shipping_option_rule'
    )
  `);

    if (tableExists.rows[0].exists) {
        console.log('✅ shipping_option_rule table exists\n');

        const rules = await client.query(`
      SELECT * FROM shipping_option_rule
      ORDER BY shipping_option_id
      LIMIT 20
    `);

        console.log('Current rules:');
        console.table(rules.rows);
    } else {
        console.log('❌ shipping_option_rule table does NOT exist');
        console.log('This might be why prices are not being calculated!\n');
    }

    // Check shipping_option_price table
    const priceTableExists = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'shipping_option_price'
    )
  `);

    if (priceTableExists.rows[0].exists) {
        console.log('\n📊 shipping_option_price table:\n');
        const prices = await client.query(`
      SELECT * FROM shipping_option_price
      ORDER BY shipping_option_id
      LIMIT 20
    `);
        console.table(prices.rows);
    }

    await client.end();
})();
