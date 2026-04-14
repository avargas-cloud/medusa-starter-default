#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function findProductsWithImages() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Find products with images
    const result = await client.query(`
            SELECT 
                p.id,
                p.title,
                p.thumbnail,
                COUNT(i.id) as image_count
            FROM product p
            LEFT JOIN image i ON i.product_id = p.id
            GROUP BY p.id, p.title, p.thumbnail
            HAVING COUNT(i.id) > 0
            ORDER BY p.created_at DESC
            LIMIT 5
        `);

    console.log(`📸 Found ${result.rows.length} products with images:\n`);

    result.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.title}`);
      console.log(`   • ID: ${row.id}`);
      console.log(`   • Thumbnail: ${row.thumbnail ? "✅" : "❌"}`);
      console.log(`   • Images: ${row.image_count}\n`);
    });

    if (result.rows.length > 0) {
      console.log(`\n🧪 Test with first product:`);
      console.log(
        `curl -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" "http://localhost:9000/store/products/${result.rows[0].id}/with-prices"`
      );
    }
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.end();
  }
}

findProductsWithImages();
