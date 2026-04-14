#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function checkImageUrls() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const r = await c.query(`
        SELECT 
            id, 
            name, 
            thumbnail,
            metadata->>'image' as image_metadata
        FROM product_category 
        WHERE handle = 'led-strips'
    `);

  const cat = r.rows[0];
  const imageObj = JSON.parse(cat.image_metadata || "{}");

  console.log("\n📦 LED Strips Category:\n");
  console.log("Column thumbnail:", cat.thumbnail);
  console.log("metadata.image.url:", imageObj.url);
  console.log("\n");
  console.log(
    "✅ Pointing to MinIO?",
    cat.thumbnail?.includes("bucket-production") ? "YES" : "NO"
  );
  console.log(
    "✅ Pointing to MinIO?",
    imageObj.url?.includes("bucket-production") ? "YES" : "NO (WooCommerce)"
  );

  await c.end();
}

checkImageUrls();
