import 'dotenv/config'
import { Client } from 'pg'
async function run() {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const r = await c.query('SELECT display_id, metadata FROM "order" WHERE display_id = 1169')
  console.log('ORDER METADATA:', JSON.stringify(r.rows, null, 2))
  const p = await c.query("SELECT id, amount, metadata FROM customer_payment WHERE metadata->>'order_display_id' = '1169'")
  console.log('PAYMENTS METADATA:', JSON.stringify(p.rows, null, 2))
  c.end()
}
run()
