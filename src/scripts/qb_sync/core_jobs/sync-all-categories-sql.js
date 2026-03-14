#!/usr/bin/env node
/**
 * SYNC ALL CATEGORIES - Direct SQL Version
 * 
 * This uses direct Postgres connection to update all categories
 * Works even when Medusa server is not running
 */

const { Client } = require('pg');

// Parse DATABASE_URL from .env
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../../.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const dbUrlMatch = envContent.match(/DATABASE_URL=(.+)/);

if (!dbUrlMatch) {
    console.error('❌ DATABASE_URL not found in .env');
    process.exit(1);
}

const DATABASE_URL = dbUrlMatch[1].trim();

async function main() {
    const client = new Client({ connectionString: DATABASE_URL });

    try {
        await client.connect();
        console.log('🔄 SYNC AVAILABLE ATTRIBUTES FOR ALL CATEGORIES (SQL Direct)\n');

        // 1. Fetch all categories
        console.log('📦 Fetching categories...');
        const categoriesResult = await client.query(`
            SELECT id, name, handle, metadata
            FROM product_category
            ORDER BY name
        `);

        const categories = categoriesResult.rows;
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

                // 2. Get PUBLISHED products in this category
                const productsResult = await client.query(`
                    SELECT DISTINCT p.id
                    FROM product p
                    INNER JOIN product_category_product pcp ON p.id = pcp.product_id
                    WHERE pcp.product_category_id = $1
                      AND p.status = 'published'
                      AND p.deleted_at IS NULL
                `, [category.id]);

                const productIds = productsResult.rows.map(r => r.id);

                if (productIds.length === 0) {
                    // Update to empty array
                    const newMetadata = { ...category.metadata, available_attributes: [] };
                    await client.query(`
                        UPDATE product_category
                        SET metadata = $1, updated_at = NOW()
                        WHERE id = $2
                    `, [JSON.stringify(newMetadata), category.id]);

                    console.log(`      → No published products (set to [])`);
                    skipped++;
                    continue;
                }

                // 3. Get unique attribute keys from these products
                const attrKeysResult = await client.query(`
                    SELECT DISTINCT av.attribute_key_id
                    FROM product_product_productattributes_attribute_value ppav
                    INNER JOIN attribute_value av ON ppav.attribute_value_id = av.id
                    WHERE ppav.product_id = ANY($1::text[])
                      AND ppav.deleted_at IS NULL
                `, [productIds]);

                const attributeKeys = attrKeysResult.rows.map(r => r.attribute_key_id);

                // 4. Update category metadata
                const newMetadata = { ...category.metadata, available_attributes: attributeKeys };
                await client.query(`
                    UPDATE product_category
                    SET metadata = $1, updated_at = NOW()
                    WHERE id = $2
                `, [JSON.stringify(newMetadata), category.id]);

                console.log(`      → Synced ${attributeKeys.length} attributes from ${productIds.length} products`);
                synced++;

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
        console.log('💡 TIP: Now when you open Admin → Filters, you\'ll see only relevant attributes\n');

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
