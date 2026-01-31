#!/usr/bin/env tsx

import { Client } from 'pg'

async function checkMetadata() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/medusa-docker'
    })

    try {
        await client.connect()
        console.log('\n🔍 Checking LED Strips category metadata...\n')

        const result = await client.query(`
            SELECT id, name, handle, metadata 
            FROM product_category 
            WHERE LOWER(name) LIKE '%led%' OR LOWER(name) LIKE '%strip%'
            ORDER BY name
        `)

        if (result.rows.length === 0) {
            console.log('❌ No categories found with LED or Strip in name\n')
            return
        }

        for (const row of result.rows) {
            console.log(`📦 ${row.name}`)
            console.log(`   ID: ${row.id}`)
            console.log(`   Handle: ${row.handle}`)

            if (row.metadata) {
                const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
                const keys = Object.keys(metadata)

                console.log(`   Metadata keys (${keys.length}): ${keys.join(', ')}`)

                if (metadata.sorting_config) {
                    const sc = metadata.sorting_config
                    console.log(`\n   ✅ SORTING CONFIG:`)
                    console.log(`      Subcategory Order: ${sc.subcategory_order?.length || 0} items`)
                    if (sc.subcategory_order && sc.subcategory_order.length > 0) {
                        console.log(`      IDs: ${JSON.stringify(sc.subcategory_order.slice(0, 3))}...`)
                    }
                    console.log(`      Product Order: ${sc.product_order?.length || 0} items`)
                    if (sc.product_order && sc.product_order.length > 0) {
                        console.log(`      IDs: ${JSON.stringify(sc.product_order.slice(0, 3))}...`)
                    }
                } else {
                    console.log(`   ❌ NO sorting_config`)
                }

                if (metadata.filter_config) {
                    console.log(`   ✅ filter_config: ${metadata.filter_config.active_filters?.length || 0} filters`)
                }

                if (metadata.thumbnail) {
                    console.log(`   ✅ thumbnail: present`)
                }

                if (metadata.prerender !== undefined) {
                    console.log(`   ✅ prerender: ${metadata.prerender}`)
                }

                console.log(`\n   📄 FULL METADATA JSON:`)
                console.log(JSON.stringify(metadata, null, 2))
            } else {
                console.log(`   ❌ NO metadata`)
            }

            console.log('\n' + '─'.repeat(80) + '\n')
        }

    } catch (error) {
        console.error('❌ Error:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

checkMetadata()
