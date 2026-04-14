import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

/**
 * Recovery Script: Restore Product-Attribute Links
 *
 * Problem: Products have Product Options but missing links in product_product_productattributes_attribute_value
 *
 * Solution:
 * 1. Find products with options but no attribute links
 * 2. For each product:
 *    - Map option title → attribute_key (by handle/label)
 *    - For each variant's option_value:
 *      - Find/create matching attribute_value
 *      - Create link: product → attribute_value
 *
 * Run: yarn medusa exec ./src/scripts/recover-product-attribute-links.ts
 */
export default async function ({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve("__pg_connection__");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("🔧 RECOVERY: Restore Product-Attribute Links\n");
  logger.info("=".repeat(60));

  // 1. Find affected products
  const affectedProducts = await knex.raw(`
        SELECT DISTINCT p.id, p.title
        FROM product p
        INNER JOIN product_option po ON po.product_id = p.id AND po.deleted_at IS NULL
        LEFT JOIN product_product_productattributes_attribute_value ppa 
            ON ppa.product_id = p.id AND ppa.deleted_at IS NULL
        WHERE ppa.id IS NULL AND p.deleted_at IS NULL
    `);

  const products = affectedProducts.rows;
  logger.info(`\n📦 Found ${products.length} products to recover`);

  if (products.length === 0) {
    logger.info("✅ No recovery needed!");
    return;
  }

  let recovered = 0;
  let skipped = 0;
  let errors = 0;

  for (const product of products) {
    try {
      logger.info(`\n🔄 Processing: ${product.title}`);

      // Get product options
      const productOptions = await knex("product_option")
        .where({ product_id: product.id })
        .whereNull("deleted_at");

      for (const option of productOptions) {
        logger.info(`   Option: "${option.title}"`);

        // Try to find matching attribute_key
        // First try exact handle match, then label match
        const normalizedTitle = option.title.toLowerCase().replace(/\s+/g, "-");

        let attributeKey = await knex("attribute_key")
          .where({ handle: normalizedTitle })
          .whereNull("deleted_at")
          .first();

        if (!attributeKey) {
          // Try by label
          attributeKey = await knex("attribute_key")
            .where({ label: option.title })
            .whereNull("deleted_at")
            .first();
        }

        if (!attributeKey) {
          logger.warn(
            `   ⚠️  No attribute_key found for "${option.title}" - SKIPPING`
          );
          skipped++;
          continue;
        }

        logger.info(
          `   ✅ Matched to attribute: ${attributeKey.label} (${attributeKey.handle})`
        );

        // Get all option values for this option
        const optionValues = await knex("product_option_value")
          .where({ option_id: option.id })
          .whereNull("deleted_at");

        logger.info(`   Found ${optionValues.length} option values`);

        // For each option value, create attribute link
        for (const optionValue of optionValues) {
          // Find or identify matching attribute_value
          let attributeValue = await knex("attribute_value")
            .where({
              attribute_key_id: attributeKey.id,
              value: optionValue.value,
            })
            .whereNull("deleted_at")
            .first();

          if (!attributeValue) {
            logger.warn(
              `      ⚠️  No attribute_value for "${optionValue.value}" - SKIPPING`
            );
            continue;
          }

          // Check if link already exists
          const existingLink = await knex(
            "product_product_productattributes_attribute_value"
          )
            .where({
              product_id: product.id,
              attribute_value_id: attributeValue.id,
            })
            .whereNull("deleted_at")
            .first();

          if (existingLink) {
            logger.info(`      • "${optionValue.value}" - already linked`);
            continue;
          }

          // Create the link
          await knex(
            "product_product_productattributes_attribute_value"
          ).insert({
            product_id: product.id,
            attribute_value_id: attributeValue.id,
            created_at: new Date(),
            updated_at: new Date(),
          });

          logger.info(`      ✅ "${optionValue.value}" - LINKED`);
        }

        recovered++;
      }
    } catch (error: any) {
      logger.error(`   ❌ Error: ${error.message}`);
      errors++;
    }
  }

  logger.info("\n" + "=".repeat(60));
  logger.info("\n📊 RECOVERY SUMMARY:");
  logger.info(`   Products processed: ${products.length}`);
  logger.info(`   Options recovered: ${recovered}`);
  logger.info(`   Skipped (no match): ${skipped}`);
  logger.info(`   Errors: ${errors}`);
  logger.info("\n" + "=".repeat(60));
  logger.info("");
}
