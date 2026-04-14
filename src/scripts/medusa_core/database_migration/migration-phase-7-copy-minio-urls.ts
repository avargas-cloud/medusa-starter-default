#!/usr/bin/env tsx
/**
 * Phase 7: Copy MinIO URLs to Metadata
 *
 * Copies the correct MinIO URLs from the thumbnail column to metadata.image.url
 * Phase 5B populated the column, but the widget reads from metadata
 */

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function copyThumbnailToMetadata() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    await client.query("BEGIN");

    // Get all categories with thumbnail column populated
    const categoriesResult = await client.query(`
            SELECT id, name, thumbnail, metadata
            FROM product_category
            WHERE thumbnail IS NOT NULL
        `);

    console.log(
      `📋 Found ${categoriesResult.rows.length} categories with thumbnails\n`
    );

    let updated = 0;

    for (const cat of categoriesResult.rows) {
      const metadata = cat.metadata as Record<string, any>;

      // Update metadata.image.url with the MinIO URL from thumbnail column
      const newMetadata = {
        ...metadata,
        image: {
          url: cat.thumbnail, // MinIO URL
        },
      };

      // Update category
      await client.query(
        `
                UPDATE product_category
                SET metadata = $1
                WHERE id = $2
            `,
        [JSON.stringify(newMetadata), cat.id]
      );

      const oldUrl = metadata.image?.url || "none";
      const isWoo = oldUrl.includes("woocommerce");

      console.log(`✅ ${cat.name}`);
      console.log(
        `   ${isWoo ? "❌" : "✅"} Old: ${oldUrl.substring(0, 80)}...`
      );
      console.log(`   ✅ New: ${cat.thumbnail}`);
      console.log("");

      updated++;
    }

    await client.query("COMMIT");

    console.log(`\n🎉 Migration Complete!`);
    console.log(`   Updated: ${updated} categories`);
    console.log(`   All metadata.image.url now point to MinIO`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

copyThumbnailToMetadata();
