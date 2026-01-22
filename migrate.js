require('dotenv').config()
const { Client } = require('pg')

async function migrate() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('✅ Connected to Railway database')

        const result = await client.query(`
      UPDATE product_category
      SET thumbnail = metadata->>'thumbnail'
      WHERE metadata->>'thumbnail' IS NOT NULL
    `)

        console.log(`✅ Updated ${result.rowCount} categories`)

        // Verify
        const verify = await client.query(`
      SELECT name, thumbnail
      FROM product_category
      WHERE thumbnail IS NOT NULL
      ORDER BY name
      LIMIT 5
    `)

        console.log('\n📋 Sample updated categories:')
        verify.rows.forEach(r => console.log(`   - ${r.name}`))

    } catch (error) {
        console.error('❌ Error:', error.message)
    } finally {
        await client.end()
    }
}

migrate()
