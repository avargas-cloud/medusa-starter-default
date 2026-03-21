import 'dotenv/config'
import { Client } from 'pg'
async function run() {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const r = await c.query('SELECT metadata FROM "order" WHERE display_id = 1168')
  console.log(JSON.stringify(r.rows, null, 2))
  c.end()
}
run()
