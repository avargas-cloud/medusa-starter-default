#!/usr/bin/env node

/**
 * AUTO-GENERATE FILTERS FOR ALL PARENT CATEGORIES
 * 
 * This script:
 * 1. Finds all TOP-LEVEL parent categories
 * 2. For each parent, finds the most common attributes across its products
 * 3. Auto-generates filters with those attributes
 * 4. Sets override_inheritance = true for parents
 * 5. Child categories automatically inherit (override_inheritance = false by default)
 * 
 * Usage: node src/scripts/auto-generate-all-filters.js
 */

const baseUrl = process.env.MEDUSA_BACKEND_URL || 'http://localhost:9000';

/**
 * Fetch all categories
 */
async function fetchCategories() {
    const response = await fetch(`${baseUrl}/admin/product-categories?limit=1000`, {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch categories: ${response.status}`);
    }

    const data = await response.json();
    return data.product_categories || [];
}

/**
 * Fetch all attribute keys
 */
async function fetchAttributes() {
    const response = await fetch(`${baseUrl}/admin/attributes?limit=1000`, {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch attributes: ${response.status}`);
    }

    const data = await response.json();
    return data.attribute_keys || [];
}

/**
 * Generate filters for a category
 */
async function generateFilters(categoryId, attributeIds) {
    const response = await fetch(`${baseUrl}/admin/product-categories/${categoryId}/generate-filters`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            active_filters: attributeIds,
            override_inheritance: true
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `Failed to generate filters: ${response.status}`);
    }

    return await response.json();
}

/**
 * Get available attributes for a category (from metadata)
 */
function getAvailableAttributes(category) {
    return category.metadata?.available_attributes || [];
}

/**
 * Main execution
 */
async function main() {
    console.log('🚀 AUTO-GENERATE FILTERS FOR ALL CATEGORIES\n');

    try {
        // 1. Fetch all categories
        console.log('📦 Fetching categories...');
        const categories = await fetchCategories();
        console.log(`   Found ${categories.length} categories\n`);

        // 2. Fetch all attributes to know which ones exist
        console.log('🏷️  Fetching attributes...');
        const attributes = await fetchAttributes();
        console.log(`   Found ${attributes.length} attributes\n`);

        // 3. Find parent categories (no parent_category_id)
        const parentCategories = categories.filter(cat => !cat.parent_category_id);
        console.log(`📊 Found ${parentCategories.length} parent categories:\n`);
        parentCategories.forEach(cat => {
            const hasFilters = cat.metadata?.filter_config?.override_inheritance;
            const status = hasFilters ? '✅' : '❌';
            console.log(`   ${status} ${cat.name} (${cat.handle})`);
        });
        console.log();

        // 4. Auto-generate filters for parents that don't have them
        console.log('🔧 Generating filters for parent categories...\n');

        let generated = 0;
        let skipped = 0;
        let failed = 0;

        for (const category of parentCategories) {
            const hasFilters = category.metadata?.filter_config?.override_inheritance;

            if (hasFilters) {
                console.log(`   ⏭️  SKIP: ${category.name} (already has filters)`);
                skipped++;
                continue;
            }

            // Get available attributes from sync
            const availableAttrs = getAvailableAttributes(category);

            if (availableAttrs.length === 0) {
                console.log(`   ⚠️  SKIP: ${category.name} (no products/attributes)`);
                skipped++;
                continue;
            }

            try {
                // Take the most common attributes (limit to top 5-7 to avoid overwhelming UI)
                const topAttributes = availableAttrs.slice(0, 7);

                console.log(`   🔄 Generating: ${category.name} with ${topAttributes.length} filters...`);

                const result = await generateFilters(category.id, topAttributes);

                console.log(`   ✅ SUCCESS: Generated ${result.filters_generated} filters for ${result.total_products} products`);
                generated++;

            } catch (error) {
                console.log(`   ❌ FAILED: ${category.name} - ${error.message}`);
                failed++;
            }
        }

        console.log('\n📈 SUMMARY:');
        console.log(`   ✅ Generated: ${generated}`);
        console.log(`   ⏭️  Skipped: ${skipped}`);
        console.log(`   ❌ Failed: ${failed}`);
        console.log(`   📊 Total: ${parentCategories.length}`);

        console.log('\n🎉 DONE!\n');
        console.log('💡 TIP: Child categories will automatically inherit filters from their parents.');
        console.log('   If you want a child category to have different filters, go to Admin UI → Filters');
        console.log('   and check "Override parent category filters"\n');

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        process.exit(1);
    }
}

main();
