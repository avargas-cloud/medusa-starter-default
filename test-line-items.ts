import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    
    // Check order_line_item
    const lineItems = await client.query(`
      SELECT item_id, order_id, unit_price
      FROM order_line_item
      LIMIT 5
    `);
    console.log('Order Line Items:', lineItems.rows);

  } catch (error) {
    console.error(error);
  } finally {
    await client.end();
  }
}

run();
