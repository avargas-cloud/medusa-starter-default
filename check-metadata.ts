#!/usr/bin/env tsx

/**
 * Check category metadata via Medusa API
 */

async function checkMetadata() {
    try {
        console.log('\n🔍 Fetching all categories with LED/Strip in name...\n')

        // Fetch categories from Admin API
        const response = await fetch(
            'http://localhost:9000/admin/product-categories?fields=id,name,handle,+metadata&limit=999',
            {
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        )

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        const allCategories = data.product_categories || []

        // Filter LED/Strip categories
        const ledCategories = allCategories.filter((c: any) =>
            c.name.toLowerCase().includes('led') ||
            c.name.toLowerCase().includes('strip')
        )

        console.log(`Found ${ledCategories.length} LED/Strip categories:\n`)

        for (const cat of ledCategories) {
            console.log(`📦 ${cat.name}`)
            console.log(`   ID: ${cat.id}`)
            console.log(`   Handle: ${cat.handle}`)

            if (cat.metadata && Object.keys(cat.metadata).length > 0) {
                const keys = Object.keys(cat.metadata)
                console.log(`   Metadata keys (${keys.length}): ${keys.join(', ')}`)

                // Check sorting_config
                if (cat.metadata.sorting_config) {
                    const sc = cat.metadata.sorting_config
                    console.log(`   ✅ sorting_config:`)
                    console.log(`      - subcategory_order: ${sc.subcategory_order?.length || 0} items`)
                    console.log(`      - product_order: ${sc.product_order?.length || 0} items`)
                } else {
                    console.log(`   ❌ NO sorting_config`)
                }

                // Check filter_config
                if (cat.metadata.filter_config) {
                    console.log(`   ✅ filter_config: ${cat.metadata.filter_config.active_filters?.length || 0} filters`)
                }

                // Check thumbnail
                if (cat.metadata.thumbnail) {
                    console.log(`   ✅ thumbnail: present`)
                }

                // Check prerender
                if (cat.metadata.prerender !== undefined) {
                    console.log(`   ✅ prerender: ${cat.metadata.prerender}`)
                }
            } else {
                console.log(`   ❌ NO metadata`)
            }
            console.log('')
        }

    } catch (error) {
        console.error('\n❌ Error:', (error as Error).message)
        process.exit(1)
    }
}

checkMetadata()
