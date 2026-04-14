// Test script to verify query.graph behavior
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function testQueryBehavior() {
  console.log("Testing why query.graph returns different results...\n");

  // Check database directly for images
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const productId = "product_01KGAX7RCXVXJVQ8QVHD7W0T54";

    // Direct DB query
    const result = await client.query(
      `
            SELECT 
                p.id,
                p.title,
                p.thumbnail,
                (SELECT COUNT(*) FROM image WHERE product_id = p.id) as image_count
            FROM product p
            WHERE p.id = $1
        `,
      [productId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log("📊 Database Direct Query:");
      console.log(`  Product: ${row.title}`);
      console.log(`  Thumbnail: ${row.thumbnail ? "✅ EXISTS" : "❌ NULL"}`);
      console.log(`  Images Count: ${row.image_count}`);
    }

    console.log(
      "\n💡 Next: Test if images table exists and has correct schema"
    );
    const tableCheck = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'image'
            ORDER BY ordinal_position
        `);

    console.log("\n📋 Image Table Schema:");
    tableCheck.rows.forEach((col) => {
      console.log(`  • ${col.column_name}: ${col.data_type}`);
    });
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.end();
  }
}

testQueryBehavior();
