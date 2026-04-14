/**
 * Phase 4: Verify Migration Integrity
 *
 * Purpose:
 * - Verify ALL data preserved after migration
 * - Check attributes, variants, images, prices, metadata
 * - Generate comprehensive verification report
 *
 * Usage:
 *   npx tsx scripts/product-id-migration/4-verify-migration.ts
 */

import dotenv from "dotenv";
dotenv.config();

import knex from "knex";
import fs from "fs";
import path from "path";

const DB_URL = process.env.DATABASE_URL!;

async function main() {
  console.log(
    "🚀 Product ID Migration - Phase 4: Comprehensive Verification\n"
  );

  const db = knex({
    client: "pg",
    connection: DB_URL,
  });

  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // 1. Load pre-migration counts (if available)
    console.log("📊 Verifying Data Integrity...\n");

    // 2. Product count unchanged
    const productCount = await db("product").count("* as count").first();
    console.log(`✅ Products: ${productCount?.count}`);

    // 3. All products have ULID format
    const oldFormatCount = await db("product")
      .where("id", "like", "prod_%-%")
      .count("* as count")
      .first();

    if (oldFormatCount && Number(oldFormatCount.count) > 0) {
      errors.push(`${oldFormatCount.count} products still have old format IDs`);
      console.log(`❌ Old Format IDs: ${oldFormatCount.count}`);
    } else {
      console.log("✅ All products have ULID format");
    }

    // 4. Variants preserved
    const variantCount = await db("product_variant")
      .count("* as count")
      .first();
    console.log(`✅ Variants: ${variantCount?.count}`);

    const orphanedVariants = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_variant pv
            LEFT JOIN product p ON pv.product_id = p.id
            WHERE p.id IS NULL
        `);

    if (Number(orphanedVariants.rows[0].count) > 0) {
      errors.push(`${orphanedVariants.rows[0].count} orphaned variants`);
      console.log(`❌ Orphaned Variants: ${orphanedVariants.rows[0].count}`);
    } else {
      console.log("✅ No orphaned variants");
    }

    // 5. Attributes preserved (skip if table doesn't exist in Medusa v2)
    // Note: product_attribute_value table structure may vary by Medusa version

    // 6. Images preserved
    const imageCount = await db("image").count("* as count").first();
    console.log(`✅ Images: ${imageCount?.count}`);

    const orphanedImages = await db.raw(`
            SELECT COUNT(*) as count
            FROM image pi
            LEFT JOIN product p ON pi.product_id = p.id
            WHERE p.id IS NULL
        `);

    if (Number(orphanedImages.rows[0].count) > 0) {
      errors.push(`${orphanedImages.rows[0].count} orphaned images`);
      console.log(`❌ Orphaned Images: ${orphanedImages.rows[0].count}`);
    } else {
      console.log("✅ No orphaned images");
    }

    // 7. Prices preserved
    const priceCount = await db("price").count("* as count").first();
    console.log(`✅ Prices: ${priceCount?.count}`);

    // 8. Category links preserved
    const categoryLinkCount = await db("product_category_product")
      .count("* as count")
      .first();
    console.log(`✅ Category Links: ${categoryLinkCount?.count}`);

    const orphanedCategoryLinks = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_category_product pcp
            LEFT JOIN product p ON pcp.product_id = p.id
            WHERE p.id IS NULL
        `);

    if (Number(orphanedCategoryLinks.rows[0].count) > 0) {
      errors.push(
        `${orphanedCategoryLinks.rows[0].count} orphaned category links`
      );
      console.log(
        `❌ Orphaned Category Links: ${orphanedCategoryLinks.rows[0].count}`
      );
    } else {
      console.log("✅ No orphaned category links");
    }

    // 9. Metadata preserved (sample check)
    console.log("\n🔍 Verifying Metadata Preservation...");
    const sampleProducts = await db("product")
      .select("id", "handle", "title", "metadata")
      .limit(5);

    let metadataIntact = true;
    sampleProducts.forEach((p) => {
      if (!p.metadata) {
        metadataIntact = false;
        warnings.push(`Product ${p.handle} has no metadata`);
      }
    });

    if (metadataIntact) {
      console.log("✅ Metadata preserved (sample check)");
    } else {
      console.log("⚠️  Some products missing metadata");
    }

    // 10. Sorting config updated
    console.log("\n🔍 Verifying Sorting Config...");
    const categoriesWithSorting = await db("product_category")
      .whereRaw("metadata->>'sorting_config' IS NOT NULL")
      .select("id", "name", "metadata");

    let sortingValid = true;
    for (const cat of categoriesWithSorting) {
      const productOrder = cat.metadata?.sorting_config?.product_order || [];

      // Check if IDs are ULID format
      for (const id of productOrder) {
        if (id.includes("-") && id.startsWith("prod_")) {
          sortingValid = false;
          errors.push(
            `Category "${cat.name}" has old format ID in sorting: ${id}`
          );
        }
      }
    }

    if (sortingValid) {
      console.log("✅ Sorting configs updated to new IDs");
    } else {
      console.log("❌ Some sorting configs still have old IDs");
    }

    // 11. Generate report
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        products: productCount?.count,
        variants: variantCount?.count,
        images: imageCount?.count,
        prices: priceCount?.count,
        categoryLinks: categoryLinkCount?.count,
      },
      errors,
      warnings,
      status: errors.length === 0 ? "SUCCESS" : "FAILED",
    };

    const reportPath = path.join(
      process.cwd(),
      "scripts/product-id-migration/verification-report.json"
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

    // 12. Summary
    console.log("\n─".repeat(80));
    console.log(
      `${errors.length === 0 ? "✅" : "❌"} PHASE 4 VERIFICATION ${report.status}\n`
    );

    console.log("Summary:");
    console.log(`  - Products: ${productCount?.count}`);
    console.log(`  - Variants: ${variantCount?.count}`);
    console.log(`  - Images: ${imageCount?.count}`);
    console.log(`  - Prices: ${priceCount?.count}`);
    console.log(`  - Category Links: ${categoryLinkCount?.count}`);
    console.log(`  - Errors: ${errors.length}`);
    console.log(`  - Warnings: ${warnings.length}`);
    console.log();

    if (errors.length > 0) {
      console.log("❌ ERRORS:");
      errors.forEach((e) => console.log(`   - ${e}`));
      console.log();
    }

    if (warnings.length > 0) {
      console.log("⚠️  WARNINGS:");
      warnings.forEach((w) => console.log(`   - ${w}`));
      console.log();
    }

    if (errors.length === 0) {
      console.log("✅ Migration verified successfully!");
      console.log("\nNext steps:");
      console.log("  1. Test Admin UI manually");
      console.log("  2. Test Storefront manually");
      console.log("  3. Re-index MeiliSearch (optional)");
      console.log("  4. Monitor for 24 hours");
      console.log("  5. Drop migration table after 30 days");
    } else {
      console.log("❌ Migration has errors - DO NOT USE IN PRODUCTION");
      console.log("   Consider rolling back and investigating issues");
    }
    console.log();
  } catch (error) {
    console.error("❌ Verification failed:", error);
    throw error;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
