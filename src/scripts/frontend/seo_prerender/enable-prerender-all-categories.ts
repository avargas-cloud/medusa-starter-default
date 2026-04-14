#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function enablePrerenderForAllCategories() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // First, check current state
    console.log("🔍 Checking current prerender status...\n");

    const currentState = await client.query(`
            SELECT 
                id, 
                name, 
                handle,
                metadata->>'prerender' as prerender_value
            FROM product_category
            ORDER BY name;
        `);

    console.log(`Found ${currentState.rows.length} categories:\n`);

    let withPrerender = 0;
    let withoutPrerender = 0;
    let prerenderFalse = 0;

    currentState.rows.forEach((row) => {
      const status =
        row.prerender_value === "true"
          ? "✅"
          : row.prerender_value === "false"
            ? "❌"
            : "⚠️ ";
      console.log(`${status} ${row.name} (${row.handle || "no-handle"})`);

      if (row.prerender_value === "true") withPrerender++;
      else if (row.prerender_value === "false") prerenderFalse++;
      else withoutPrerender++;
    });

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ prerender=true: ${withPrerender}`);
    console.log(`   ❌ prerender=false: ${prerenderFalse}`);
    console.log(`   ⚠️  no prerender field: ${withoutPrerender}`);

    // Update all categories
    console.log(`\n🔨 Updating all categories to prerender=true...\n`);

    const updateResult = await client.query(`
            UPDATE product_category
            SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"prerender": true}'::jsonb
            WHERE metadata->>'prerender' != 'true' OR metadata->>'prerender' IS NULL;
        `);

    console.log(`✅ Updated ${updateResult.rowCount} categories\n`);

    // Verify
    console.log("🔍 Verifying update...\n");

    const verifyResult = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE metadata->>'prerender' = 'true') as with_prerender
            FROM product_category;
        `);

    const { total, with_prerender } = verifyResult.rows[0];

    if (total === with_prerender) {
      console.log(
        `✅ SUCCESS! All ${total} categories now have prerender=true\n`
      );
    } else {
      console.log(
        `⚠️  WARNING: ${total - with_prerender} categories still missing prerender=true\n`
      );
    }
  } catch (error) {
    console.error("❌ Error:", (error as Error).message);
    throw error;
  } finally {
    await client.end();
  }
}

enablePrerenderForAllCategories().catch(console.error);
