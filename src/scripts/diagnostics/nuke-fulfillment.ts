import { Pool } from 'pg'
import { config } from 'dotenv'
config()

async function run() {
  const fulfillmentId = process.argv[2]
  if (!fulfillmentId) {
    console.error("Please provide a fulfillment id")
    process.exit(1)
  }

  console.log(`Nuking fulfillment ${fulfillmentId}...`)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  await pool.query(`UPDATE fulfillment_label SET deleted_at = NOW() WHERE fulfillment_id = $1`, [fulfillmentId])
  await pool.query(`UPDATE fulfillment_item SET deleted_at = NOW() WHERE fulfillment_id = $1`, [fulfillmentId])
  await pool.query(`UPDATE order_fulfillment SET deleted_at = NOW() WHERE fulfillment_id = $1`, [fulfillmentId])
  await pool.query(`UPDATE fulfillment SET deleted_at = NOW(), canceled_at = NOW() WHERE id = $1`, [fulfillmentId])

  console.log(`Successfully nuked!`)
  process.exit(0)
}

run().catch(console.error)
