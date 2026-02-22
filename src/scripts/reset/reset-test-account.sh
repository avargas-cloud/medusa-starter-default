#!/bin/bash

EMAIL="a.vargas@ecopowertech.com"

echo "🔍 Verificando estado de $EMAIL..."
echo ""

# Check using the Medusa CLI with DB connection
cat > /tmp/check-status.mjs << 'SCRIPT'
import { loadEnv } from "@medusajs/framework/utils"
loadEnv(process.env.NODE_ENV || "development", process.cwd())

const { Client } = await import('pg')
const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const email = 'a.vargas@ecopowertech.com'

// Check customer
const customerRes = await client.query(`
  SELECT id, email, has_account, metadata
  FROM customer
  WHERE email = $1
`, [email])

const customer = customerRes.rows[0]

console.log('📧 Email:', customer.email)
console.log('🔐 has_account:', customer.has_account)
console.log('🏷️  legacy_customer:', customer.metadata?.legacy_customer)
console.log('📅 activated_at:', customer.metadata?.activated_at)
console.log('')

// Check auth
const authRes = await client.query(`
  SELECT COUNT(*) as count
  FROM provider_identity
  WHERE entity_id = $1
`, [email])

const authCount = parseInt(authRes.rows[0].count)
console.log('🔑 Auth identities:', authCount)
console.log('')

if (customer.has_account === true || authCount > 0 || !customer.metadata?.legacy_customer) {
  console.log('❌ CUENTA YA ACTIVADA - Necesita reset')
  console.log('')
  console.log('¿Quieres resetearla a estado virgen? (y/n)')
  
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  
  rl.question('', async (answer) => {
    if (answer.toLowerCase() === 'y') {
      console.log('')
      console.log('🔄 Reseteando cuenta...')
      
      // Delete auth identities
      await client.query(`
        DELETE FROM provider_identity WHERE entity_id = $1
      `, [email])
      
      // Reset customer
      await client.query(`
        UPDATE customer 
        SET has_account = false,
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb) - 'activated_at',
              '{legacy_customer}',
              'true'
            )
        WHERE email = $1
      `, [email])
      
      console.log('✅ CUENTA RESETEADA A ESTADO VIRGEN')
      console.log('')
      console.log('Ahora puedes:')
      console.log('1. Ejecutar: node src/scripts/test-legacy-customer.mjs')
      console.log('2. Revisar tu email para el activation link')
      console.log('3. Probar la activación en el frontend')
    } else {
      console.log('Operación cancelada')
    }
    
    await client.end()
    rl.close()
    process.exit(0)
  })
} else {
  console.log('✅ CUENTA LEGACY VIRGEN - Lista para probar')
  await client.end()
  process.exit(0)
}
SCRIPT

node /tmp/check-status.mjs
