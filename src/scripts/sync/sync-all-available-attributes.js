/**
 * SYNC ALL CATEGORIES - Simple SQL approach
 * 
 * Calls the sync-attributes endpoint for each category
 */

const http = require('http');
const https = require('https');

const baseUrl = process.env.MEDUSA_BACKEND_URL || 'http://localhost:9000';

async function fetchCategories() {
    const url = `${baseUrl}/admin/product-categories?limit=1000`;

    return new Promise((resolve, reject) => {
        const client = baseUrl.startsWith('https') ? https : http;

        client.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function syncCategory(categoryId) {
    const url = `${baseUrl}/admin/product-categories/${categoryId}/sync-attributes`;

    return new Promise((resolve, reject) => {
        const client = baseUrl.startsWith('https') ? https : http;
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': 0
            }
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🔄 SYNC AVAILABLE ATTRIBUTES FOR ALL CATEGORIES\n');

    try {
        console.log('📦 Fetching categories...');
        const response = await fetchCategories();
        const categories = response.product_categories || [];

        console.log(`   Found ${categories.length} categories\n`);
        console.log('🔧 Syncing attributes...\n');

        let synced = 0;
        let skipped = 0;
        let failed = 0;

        for (const category of categories) {
            const hasAvailableAttrs = category.metadata?.available_attributes !== undefined;
            const status = hasAvailableAttrs ? '✅' : '❌';

            try {
                console.log(`   ${status} ${category.name} (${category.handle})`);

                const result = await syncCategory(category.id);

                if (result.attributeCount === 0) {
                    console.log(`      → No products/attributes (set to [])`);
                    skipped++;
                } else {
                    console.log(`      → Synced ${result.attributeCount} attributes from ${result.productCount} products`);
                    synced++;
                }

                // Small delay to avoid overwhelming the server
                await sleep(100);

            } catch (error) {
                console.log(`      → ❌ FAILED: ${error.message}`);
                failed++;
            }
        }

        console.log('\n📈 SUMMARY:');
        console.log(`   ✅ Synced: ${synced}`);
        console.log(`   ⏭️  Skipped: ${skipped} (empty categories)`);
        console.log(`   ❌ Failed: ${failed}`);
        console.log(`   📊 Total: ${categories.length}`);

        console.log('\n🎉 DONE!\n');
        console.log('💡 TIP: Now when you open Admin → Filters, you\'ll see only relevant attributes');
        console.log('   for each category instead of all system attributes.\n');

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        process.exit(1);
    }
}

main();
