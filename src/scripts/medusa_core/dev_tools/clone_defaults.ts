import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  
  // 1. Clone Estimate Status, Lead Time, Order Type from Order -> Customer
  const { rows: orderRows } = await client.query(
    "SELECT * FROM system_defaults WHERE context = 'Order Defaults' AND field_name IN ('Estimate Status', 'Lead Time', 'Order Type')"
  )
  
  for (const r of orderRows) {
    await client.query(
      "INSERT INTO system_defaults (context, field_name, value, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      ['Customer Defaults', r.field_name, r.value, r.sort_order]
    )
  }
  
  // 2. Clone Terms from Customer -> Order (as Payment Terms)
  const { rows: termsRows } = await client.query(
    "SELECT * FROM system_defaults WHERE context = 'Customer Defaults' AND field_name = 'Terms'"
  )
  
  for (const r of termsRows) {
    // Wait, let's keep it 'Terms' or 'Payment Terms'? The user explicitly typed:
    // "Agregar Payment Terms en Order Default"
    // However, in EstimateMetaFields, it's called "Payment Terms" visually, but it is read from the backend as field_name: "Terms" if context is 'Customer Defaults'.
    // If we add it to 'Order Defaults', we should name it "Payment Terms" as the user requested.
    await client.query(
      "INSERT INTO system_defaults (context, field_name, value, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      ['Order Defaults', 'Payment Terms', r.value, r.sort_order]
    )
  }
  
  console.log('Cloned rows successfully.')
  await client.end()
}
run().catch(console.error)
