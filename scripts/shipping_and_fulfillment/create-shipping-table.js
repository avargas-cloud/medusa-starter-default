require('dotenv').config();
const { Client } = require('pg');


async function createTable() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('Connected to database');

        await client.query(`
            CREATE TABLE IF NOT EXISTS shipping_settings (
                id VARCHAR(255) PRIMARY KEY DEFAULT 'default',
                free_shipping_minimum INT NOT NULL DEFAULT 0,
                regular_ground_shipping_price INT NOT NULL DEFAULT 0,
                long_item_ground_shipping_price INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log('✅ Table created');

        await client.query(`
            INSERT INTO shipping_settings (id, free_shipping_minimum, regular_ground_shipping_price, long_item_ground_shipping_price)
            VALUES ('default', 0, 0, 0)
            ON CONFLICT (id) DO NOTHING;
        `);
        console.log('✅ Default values inserted');

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await client.end();
    }
}

createTable();
