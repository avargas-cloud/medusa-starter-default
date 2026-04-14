import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Create Product Types for Ecopowertech
 *
 * Creates the following product types:
 * - LED Strips
 * - LED Modules
 * - LED Neon
 * - LED Channels
 * - LED Drivers
 * - LED Controllers
 * - LED Panels
 * - LED Landscaping
 * - LED Ceiling
 */

export default async function createProductTypes({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log("📦 Creating Product Types...\n");

  const productService = container.resolve(Modules.PRODUCT);

  const productTypes = [
    "LED Strips",
    "LED Modules",
    "LED Neon",
    "LED Channels",
    "LED Drivers",
    "LED Controllers",
    "LED Panels",
    "LED Landscaping",
    "LED Ceiling",
  ];

  let created = 0;
  let skipped = 0;

  for (const typeName of productTypes) {
    try {
      // Check if already exists
      const existing = await productService.listProductTypes({
        value: typeName,
      });

      if (existing.length > 0) {
        console.log(`⏭️  "${typeName}": Already exists`);
        skipped++;
        continue;
      }

      // Create product type
      await productService.createProductTypes({
        value: typeName,
      });

      console.log(`✅ "${typeName}": Created`);
      created++;
    } catch (error: any) {
      console.error(`❌ "${typeName}": ${error.message}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("📊 SUMMARY");
  console.log("=".repeat(70));
  console.log(`Total: ${productTypes.length}`);
  console.log(`Created: ${created}`);
  console.log(`Skipped (already exist): ${skipped}`);

  console.log(`\n✅ Done! Product types are now available in admin.`);

  return { created, skipped };
}
