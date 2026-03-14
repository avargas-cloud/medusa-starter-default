#!/usr/bin/env node

/**
 * Quick script to test category metadata for led-strips-white
 */

const http = require('http');

// First, let's try to get the category ID
const getCategoryByHandle = (handle) => {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 9000,
            path: `/admin/product-categories?handle=${handle}&limit=1`,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
};

// Then get filters for that category
const getCategoryFilters = (categoryId) => {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 9000,
            path: `/store/categories/${categoryId}/filters`,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
};

async function main() {
    console.log('🔍 Testing category metadata for: led-strips-white\n');

    try {
        console.log('Step 1: Getting category from admin API...');
        const categoryData = await getCategoryByHandle('led-strips-white');

        if (!categoryData.product_categories || categoryData.product_categories.length === 0) {
            console.error('❌ Category not found!');
            process.exit(1);
        }

        const category = categoryData.product_categories[0];
        console.log(`✅ Found category: ${category.name} (ID: ${category.id})`);
        console.log(`   Handle: ${category.handle}`);
        console.log(`   Metadata:`, JSON.stringify(category.metadata, null, 2));

        console.log('\nStep 2: Getting filters from store API...');
        const filtersData = await getCategoryFilters(category.id);

        console.log('✅ Filters response:');
        console.log(JSON.stringify(filtersData, null, 2));

        if (!filtersData.filters || filtersData.filters.length === 0) {
            console.log('\n⚠️  WARNING: No filters returned!');
            console.log('   This is what the frontend receives (empty filters array)');
        } else {
            console.log(`\n✅ SUCCESS: ${filtersData.filters.length} filters found`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
