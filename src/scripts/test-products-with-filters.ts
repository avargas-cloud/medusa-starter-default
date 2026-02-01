#!/usr/bin/env tsx
/**
 * Test script for /store/categories/:id/products-with-filters endpoint
 */

const API_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
const BASE_URL = 'http://localhost:9000'

async function testEndpoint(categoryId: string, limit = 5) {
    console.log(`\n🧪 Testing endpoint with category: ${categoryId}\n`)

    const url = `${BASE_URL}/store/categories/${categoryId}/products-with-filters?limit=${limit}`

    console.log(`📡 URL: ${url}\n`)

    try {
        const response = await fetch(url, {
            headers: {
                'x-publishable-api-key': API_KEY
            }
        })

        console.log(`📊 Status: ${response.status} ${response.statusText}`)

        if (!response.ok) {
            const text = await response.text()
            console.error(`❌ Error response: ${text}`)
            return
        }

        const data = await response.json()

        // Category info
        console.log(`\n📁 Category:`)
        console.log(`   Name: ${data.category?.name}`)
        console.log(`   Handle: ${data.category?.handle}`)
        console.log(`   Include descendants: ${data.category?.include_descendants_tree}`)

        // Products
        console.log(`\n📦 Products:`)
        console.log(`   Returned: ${data.products?.length || 0}`)
        console.log(`   Total: ${data.pagination?.total}`)

        if (data.products && data.products.length > 0) {
            const firstProduct = data.products[0]
            console.log(`\n   First product:`)
            console.log(`   - Title: ${firstProduct.title}`)
            console.log(`   - ID: ${firstProduct.id}`)
            console.log(`   - Variants: ${firstProduct.variants?.length || 0}`)
            console.log(`   - Attributes: ${firstProduct.attributes?.length || 0}`)

            if (firstProduct.price) {
                console.log(`   - Price: $${firstProduct.price.amount} ${firstProduct.price.currency_code}`)
            } else if (firstProduct.price_range) {
                console.log(`   - Price range: $${firstProduct.price_range.min.amount} - $${firstProduct.price_range.max.amount}`)
            }
        }

        // Filters
        console.log(`\n🔍 Filters:`)
        console.log(`   Count: ${data.filters?.length || 0}`)

        if (data.filters && data.filters.length > 0) {
            data.filters.forEach((filter: any, i: number) => {
                console.log(`\n   Filter ${i + 1}:`)
                console.log(`   - Name: ${filter.name}`)
                console.log(`   - Attribute: ${filter.attribute}`)
                console.log(`   - Options: ${filter.options?.length || 0}`)

                if (filter.options && filter.options.length > 0) {
                    const topOptions = filter.options.slice(0, 3)
                    topOptions.forEach((opt: any) => {
                        console.log(`     • ${opt.option}: ${opt.count} products`)
                    })
                    if (filter.options.length > 3) {
                        console.log(`     ... and ${filter.options.length - 3} more`)
                    }
                }
            })
        }

        // Pagination
        console.log(`\n📄 Pagination:`)
        console.log(`   Limit: ${data.pagination?.limit}`)
        console.log(`   Offset: ${data.pagination?.offset}`)
        console.log(`   Has more: ${data.pagination?.has_more}`)

        console.log(`\n✅ Test completed successfully!\n`)

    } catch (error: any) {
        console.error(`\n❌ Test failed:`, error.message)
    }
}

// Test with LED Strips category
const categoryId = process.argv[2] || 'pcat_01JHJG30GNRTZ4NKT3YHRQGQED'
const limit = parseInt(process.argv[3] || '5')

testEndpoint(categoryId, limit)
