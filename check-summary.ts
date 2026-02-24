import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client(process.env.DATABASE_URL);
client.connect().then(async () => {
    try {
        const orderRes = await client.query('SELECT id, display_id FROM "order" ORDER BY display_id DESC LIMIT 3');
        for (const order of orderRes.rows) {
            console.log('\n--- Order:', order.display_id, '---');
            const summary = await client.query('SELECT totals FROM order_summary WHERE order_id = $1', [order.id]);
            console.log('Summary Totals:', JSON.stringify(summary.rows[0]?.totals, null, 2));
            const items = await client.query('SELECT unit_price FROM order_item WHERE order_id = $1', [order.id]);
            console.log('Order Items Price:', items.rows.map(r => r.unit_price));
        }
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await client.end();
    }
});
