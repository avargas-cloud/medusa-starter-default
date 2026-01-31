#!/usr/bin/env tsx

import { Client } from 'pg'

async function findTestCategory() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        // Find categories with 2-5 children (not too many, good for testing)
        const result = await client.query(`
            SELECT 
                parent.id,
                parent.name,
                parent.handle,
                COUNT(child.id) as child_count,
                COUNT(pcp.product_id) as product_count
            FROM product_category parent
            LEFT JOIN product_category child ON child.parent_category_id = parent.id
            LEFT JOIN product_category_product pcp ON pcp.product_category_id = parent.id
            WHERE parent.id IN (
                SELECT DISTINCT parent_category_id 
                FROM product_category 
                WHERE parent_category_id IS NOT NULL
            )
            GROUP BY parent.id, parent.name, parent.handle
            HAVING COUNT(child.id) BETWEEN 2 AND 5
            ORDER BY COUNT(child.id) ASC
            LIMIT 5
        `)

        console.log('\n📋 Best categories for Phase 1 test:\n')
        result.rows.forEach((row, i) => {
            console.log(`${i + 1}. ${row.name}`)
            console.log(`   ID: ${row.id}`)
            console.log(`   Children: ${row.child_count}`)
            console.log(`   Products: ${row.product_count}`)
            console.log('')
        })

        if (result.rows.length > 0) {
            const selected = result.rows[0]
            console.log(`✅ RECOMMENDED: "${selected.name}" (${selected.child_count} children, ${selected.product_count} products)\n`)
        }

    } catch (error) {
        console.error('Error:', (error as Error).message)
    } finally {
        await client.end()
    }
}

findTestCategory()
