#!/usr/bin/env tsx

/**
 * ☢️ TRUE NUCLEAR SYNC - CLI Version ☢️
 *
 * Auto-discovers and generates filters for ALL 126 categories
 * Can be run in background: npx medusa exec src/scripts/true-nuclear-sync.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { generateFiltersForCategory } from "../api/admin/product-categories/[id]/generate-filters/generator";

export default async function ({ container }: { container: MedusaContainer }) {
  const query = container.resolve("query") as any;
  const knex = container.resolve("__pg_connection__") as any;

  console.log("\n");
  console.log("☢️ ".repeat(40));
  console.log("         TRUE NUCLEAR FILTER SYNC - ALL CATEGORIES");
  console.log("☢️ ".repeat(40));
  console.log("\n");

  const startTime = Date.now();

  try {
    // 1. Get ALL categories
    const { data: allCategories } = await query.graph({
      entity: "product_category",
      fields: ["id", "handle", "name", "parent_category_id", "metadata"],
      filters: {},
    });

    console.log(`📦 Found ${allCategories.length} total categories\n`);

    // Helper: Get descendants
    function getDescendants(categoryId: string): string[] {
      const descendants: string[] = [];
      for (const cat of allCategories) {
        if (cat.parent_category_id === categoryId) {
          descendants.push(cat.id);
          descendants.push(...getDescendants(cat.id));
        }
      }
      return descendants;
    }

    let phase1Success = 0;
    let phase1Skipped = 0;
    let phase2Success = 0;
    let phase2Failed = 0;

    // PHASE 1: Auto-discover and configure filters
    console.log("═".repeat(80));
    console.log("🔬 PHASE 1: Auto-discover filters for ALL categories");
    console.log("═".repeat(80));
    console.log("");

    for (let i = 0; i < allCategories.length; i++) {
      const category = allCategories[i];
      const progress = `[${i + 1}/${allCategories.length}]`;

      // Parse metadata
      let metadata: any = {};
      try {
        metadata =
          typeof category.metadata === "string"
            ? JSON.parse(category.metadata)
            : category.metadata || {};
      } catch (e) {
        metadata = {};
      }

      // Read setting
      const includeDescendants = metadata?.include_descendants_tree ?? true;

      // Build category list
      const categoryIdsToScan = includeDescendants
        ? [category.id, ...getDescendants(category.id)]
        : [category.id];

      // Get products
      const { data: products } = await query.graph({
        entity: "product",
        fields: ["id"],
        filters: {
          status: "published",
          categories: { id: categoryIdsToScan },
        },
      });

      if (!products || products.length === 0) {
        console.log(`⊘  ${progress} ${category.name} - No products, skipped`);
        phase1Skipped++;
        continue;
      }

      const productIds = products.map((p: any) => p.id);

      // Get attributes using Knex directly (correct link table name)
      const attributeValues = await knex("attribute_value as av")
        .join(
          "product_product_productattributes_attribute_value as link",
          "av.id",
          "link.attribute_value_id"
        )
        .whereIn("link.product_id", productIds)
        .select("av.attribute_key_id")
        .distinct();

      const uniqueAttrIds = attributeValues.map(
        (row: any) => row.attribute_key_id
      );

      if (uniqueAttrIds.length === 0) {
        console.log(`⊘  ${progress} ${category.name} - No attributes, skipped`);
        phase1Skipped++;
        continue;
      }

      // Build filter_config
      const availableFilters = uniqueAttrIds.map((attrId: any, index: any) => ({
        attribute_id: attrId,
        order: index,
        type: "checkbox",
      }));

      // ⭐ PRESERVE existing active_filters, don't auto-activate
      // Only keep active filters that still exist in available_filters
      const existingActiveFilters =
        metadata?.filter_config?.active_filters || [];
      const activeFilters = existingActiveFilters.filter((id: string) =>
        uniqueAttrIds.includes(id)
      );

      const newMetadata = {
        ...metadata,
        filter_config: {
          override_inheritance:
            metadata?.filter_config?.override_inheritance ?? false,
          available_filters: availableFilters,
          active_filters: activeFilters, // ⭐ Preserved, not auto-activated
        },
      };

      // Update category
      await knex("product_category")
        .where("id", category.id)
        .update({
          metadata: JSON.stringify(newMetadata),
          updated_at: new Date(),
        });

      console.log(
        `✅ ${progress} ${category.name} - ${uniqueAttrIds.length} filters configured`
      );
      phase1Success++;
    }

    console.log("");
    console.log("═".repeat(80));
    console.log(
      `✅ PHASE 1 Complete: ${phase1Success} configured, ${phase1Skipped} skipped`
    );
    console.log("═".repeat(80));
    console.log("");

    // PHASE 2: Generate filter counts
    console.log("═".repeat(80));
    console.log("📊 PHASE 2: Generate filter counts");
    console.log("═".repeat(80));
    console.log("");

    // Re-fetch categories
    const { data: updatedCategories } = await query.graph({
      entity: "product_category",
      fields: ["id", "handle", "name", "metadata"],
      filters: {},
    });

    const categoriesWithFilters = updatedCategories.filter((cat: any) => {
      let metadata: any = {};
      try {
        metadata =
          typeof cat.metadata === "string"
            ? JSON.parse(cat.metadata)
            : cat.metadata || {};
      } catch (e) {
        metadata = {};
      }
      return metadata?.filter_config?.active_filters?.length > 0;
    });

    console.log(
      `Generating counts for ${categoriesWithFilters.length} categories...\n`
    );

    for (let i = 0; i < categoriesWithFilters.length; i++) {
      const category = categoriesWithFilters[i];
      const progress = `[${i + 1}/${categoriesWithFilters.length}]`;

      try {
        // Parse metadata
        let metadata: any = {};
        try {
          metadata =
            typeof category.metadata === "string"
              ? JSON.parse(category.metadata)
              : category.metadata || {};
        } catch (e) {
          metadata = {};
        }

        const filterConfig = metadata.filter_config;
        const activeFilterIds = filterConfig.active_filters;
        const includeDescendants = metadata?.include_descendants_tree ?? true;

        // Generate
        const result = await generateFiltersForCategory(
          category.id,
          activeFilterIds,
          query,
          knex,
          includeDescendants
        );

        // Update
        await knex("product_category")
          .where("id", category.id)
          .update({
            metadata: knex.raw("jsonb_set(metadata, '{filters}', ?)", [
              JSON.stringify(result.filters),
            ]),
            updated_at: new Date(),
          });

        console.log(
          `✅ ${progress} ${category.name} - ${result.filters.length} filters generated`
        );
        phase2Success++;
      } catch (error: any) {
        console.error(
          `❌ ${progress} ${category.name} - Error: ${error.message}`
        );
        phase2Failed++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("");
    console.log("═".repeat(80));
    console.log(
      `✅ PHASE 2 Complete: ${phase2Success} generated, ${phase2Failed} failed`
    );
    console.log("═".repeat(80));
    console.log("");
    console.log("☢️ ".repeat(40));
    console.log(`         NUCLEAR SYNC COMPLETE in ${duration}s`);
    console.log("☢️ ".repeat(40));
    console.log("");
    console.log(`📊 Final Stats:`);
    console.log(`   Total categories: ${allCategories.length}`);
    console.log(`   Configured: ${phase1Success}`);
    console.log(`   Skipped: ${phase1Skipped}`);
    console.log(`   Generated: ${phase2Success}`);
    console.log(`   Failed: ${phase2Failed}`);
    console.log("");
  } catch (error: any) {
    console.error("\n❌ FATAL ERROR:", error.message);
    console.error(error.stack);
    throw error;
  }
}
