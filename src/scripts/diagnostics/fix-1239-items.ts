import { Pool } from 'pg'
import { config } from 'dotenv'

export default async function run({ container }: any) {
  config()
  const orderId = 'order_01KMJTX1NJ7DDWD0PFDCBXACFV'
  console.log(`Fixing items for order ${orderId}...`)
  
  const query = container.resolve('query')
  const { data: [order] } = await query.graph({
    entity: 'order',
    fields: ['items.*'],
    filters: { id: orderId }
  })

  if (!order || !order.items) {
    console.log('No order or items found.')
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  
  for (const item of order.items) {
    console.log(`Updating item ${item.id} (${item.title}) - currently fulfilled: ${item.fulfilled_quantity}`)
    const res = await pool.query(
      `UPDATE order_item SET fulfilled_quantity = 0, delivered_quantity = 0 WHERE id = $1`, 
      [item.id]
    )
    console.log(`Rows affected: ${res.rowCount}`)
  }

  console.log('Finished updating items!')
  process.exit(0)
}
