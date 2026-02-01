#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function testEndpoint() {
    // Simular lo que hace el endpoint
    const productId = 'prod_01KFKF46EHGHCB46SH5JA9HK42';

    console.log('🧪 Testing /with-prices endpoint logic...\n');

    // Test 1: Check what query.graph returns for images
    const testQuery = `
        SELECT 
            p.id,
            p.title,
            p.thumbnail,
            json_agg(
                json_build_object(
                    'id', i.id,
                    'url', i.url
                )
            ) FILTER (WHERE i.id IS NOT NULL) as images
        FROM product p
        LEFT JOIN image i ON i.product_id = p.id
        WHERE p.id = '${productId}'
        GROUP BY p.id, p.title, p.thumbnail
    `;

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();

        const result = await client.query(testQuery);

        if (result.rows.length > 0) {
            const product = result.rows[0];
            console.log('📊 Database Query Result:');
            console.log('  • ID:', product.id);
            console.log('  • Title:', product.title);
            console.log('  • Thumbnail:', product.thumbnail || 'null');
            console.log('  • Images:', product.images ? JSON.stringify(product.images, null, 2) : 'null');

            console.log('\n✅ Endpoint should return:');
            console.log(JSON.stringify({
                product: {
                    id: product.id,
                    title: product.title,
                    thumbnail: product.thumbnail,
                    images: product.images
                }
            }, null, 2));
        } else {
            console.log('❌ Product not found in database');
        }

    } catch (error: any) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        await client.end();
    }
}

testEndpoint();
