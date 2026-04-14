#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

/**
 * Populate active_filters for categories that inherit from parent
 * This fixes categories that have override_inheritance=false but empty active_filters
 */
async function populateInheritedFilters() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    console.log("\n🔄 Populating inherited filters for categories...\n");

    // Get all categories
    const categoriesResult = await client.query(`
            SELECT id, name, handle, metadata, parent_category_id
            FROM product_category
            WHERE parent_category_id IS NOT NULL
        `);

    let updatedCount = 0;

    for (const category of categoriesResult.rows) {
      const filterConfig = category.metadata?.filter_config;

      if (!filterConfig) continue;

      const overrideInheritance = filterConfig.override_inheritance ?? false;
      const activeFilters = filterConfig.active_filters || [];
      const availableFilters = filterConfig.available_filters || [];

      // Skip if already has active filters or is overriding
      if (overrideInheritance || activeFilters.length > 0) {
        continue;
      }

      // Get parent's active filters
      const parentResult = await client.query(
        `
                SELECT metadata
                FROM product_category
                WHERE id = $1
            `,
        [category.parent_category_id]
      );

      if (parentResult.rows.length === 0) continue;

      const parentFilterConfig = parentResult.rows[0].metadata?.filter_config;
      const parentActiveFilters = parentFilterConfig?.active_filters || [];

      if (parentActiveFilters.length === 0) {
        console.log(`  ⏭️  ${category.name} - parent has no active filters`);
        continue;
      }

      // Parse parent's active_filters (could be string[] or object[])
      let parentActiveIds: string[] = [];
      if (parentActiveFilters.length > 0) {
        const first = parentActiveFilters[0];
        if (typeof first === "string") {
          parentActiveIds = parentActiveFilters;
        } else if (first?.attribute_id) {
          parentActiveIds = parentActiveFilters.map((f: any) => f.attribute_id);
        }
      }

      // Parse available filters (only inherit what's available in this category)
      let availableIds: string[] = [];
      if (availableFilters.length > 0) {
        const first = availableFilters[0];
        if (typeof first === "string") {
          availableIds = availableFilters;
        } else if (first?.attribute_id) {
          availableIds = availableFilters.map((f: any) => f.attribute_id);
        }
      }

      // Intersection: parent's filters ∩ child's available filters
      const inheritedFilterIds = parentActiveIds.filter((filterId) =>
        availableIds.includes(filterId)
      );

      if (inheritedFilterIds.length === 0) {
        console.log(`  ⚠️  ${category.name} - no overlap with parent filters`);
        continue;
      }

      // Update category with inherited filters
      const updatedMetadata = {
        ...category.metadata,
        filter_config: {
          ...filterConfig,
          active_filters: inheritedFilterIds,
        },
      };

      await client.query(
        `
                UPDATE product_category
                SET metadata = $1, updated_at = NOW()
                WHERE id = $2
            `,
        [JSON.stringify(updatedMetadata), category.id]
      );

      console.log(
        `  ✅ ${category.name} - inherited ${inheritedFilterIds.length} filters from parent`
      );
      updatedCount++;
    }

    console.log(
      `\n✅ Updated ${updatedCount} categories with inherited filters\n`
    );
  } finally {
    await client.end();
  }
}

populateInheritedFilters();
