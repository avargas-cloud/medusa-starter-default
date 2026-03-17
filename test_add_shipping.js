const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
    try {
        const smId = 'sm_test_' + Date.now();
        const linkId = 'ordsm_test_' + Date.now();
        const finalAmount = 0;
        const rawAmount = JSON.stringify({ value: '0', precision: 20 });
        const shipping_option_id = 'so_test';
        const shippingName = 'Local Pickup';
        const id = 'order_01KKYPZ7S6F8S44J1SDTQW36Z6'; // An existing order ID

        await pool.query(
            "INSERT INTO order_shipping_method (id, shipping_option_id, amount, raw_amount, name, is_tax_inclusive, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())",
            [smId, shipping_option_id, finalAmount, rawAmount, shippingName]
        );
        console.log('Inserted method');

        await pool.query(
            "INSERT INTO order_shipping (id, order_id, shipping_method_id, version, created_at, updated_at) VALUES ($1, $2, $3, 1, NOW(), NOW())",
            [linkId, id, smId]
        );
        console.log('Inserted link');

        console.log('Success');
    } catch(e) {
        console.error('Error:', e);
    } finally {
        pool.end();
    }
}
run();
