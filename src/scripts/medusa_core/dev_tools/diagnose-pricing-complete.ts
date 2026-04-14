import dotenv from "dotenv";
import pkg from "pg";
const { Client } = pkg;

dotenv.config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();

  try {
    console.log("=== DIAGNOSTIC: PR ICING CONFIGURATION ===\n");

    // 1. Check variant -> price_set linkage
    console.log("1️⃣  VARIANT -> PRICE_SET LINKAGE");
    const variantLinks = await client.query(`
            SELECT 
                pv.id as variant_id,
                pv.sku,
                pv.title,
                pvps.price_set_id,
                CASE WHEN pvps.price_set_id IS NULL THEN '❌ NO PRICE_SET' ELSE '✅ LINKED' END as status
            FROM product_variant pv
            LEFT JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
            WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
        `);
    console.table(variantLinks.rows);

    if (variantLinks.rows.some((r) => !r.price_set_id)) {
      console.log("⚠️  PROBLEM: Some variants are missing price_set_id!\n");
    }

    // 2. Check price_set configuration
    const priceSetIds = variantLinks.rows
      .map((r) => r.price_set_id)
      .filter(Boolean);

    if (priceSetIds.length > 0) {
      console.log("\n2️⃣  PRICE_SET CONFIGURATION");
      const priceSets = await client.query(
        `
                SELECT * FROM price_set WHERE id = ANY($1)
            `,
        [priceSetIds]
      );
      console.table(priceSets.rows);

      // 3. Check actual prices
      console.log("\n3️⃣  PRICES IN DATABASE");
      const prices = await client.query(
        `
                SELECT 
                    p.id,
                    p.price_set_id,
                    p.amount,
                    p.currency_code,
                    p.min_quantity,
                    p.max_quantity,
                    p.price_list_id,
                    p.rules_count,
                    CASE 
                        WHEN p.price_list_id IS NOT NULL THEN '💰 Price List'
                        ELSE '💵 Base Price'
                    END as type
                FROM price p
                WHERE p.price_set_id = ANY($1)
                AND p.deleted_at IS NULL
                ORDER BY p.price_set_id, p.price_list_id NULLS FIRST
            `,
        [priceSetIds]
      );
      console.table(prices.rows);

      if (prices.rows.length === 0) {
        console.log("❌ CRITICAL: NO PRICES FOUND for these price_sets!\n");
      }

      // 4. Check if price_set table has money_amount column
      console.log("\n4️⃣  PRICE_SET SCHEMA CHECK");
      const schema = await client.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = 'price_set'
            `);
      console.table(schema.rows);

      // 5. Check region configuration
      console.log("\n5️⃣  REGION CONFIGURATION");
      const regions = await client.query(`
                SELECT id, name, currency_code, metadata
                FROM region
                WHERE deleted_at IS NULL
            `);
      console.table(regions.rows);

      // 6. Check if there are price rules
      console.log("\n6️⃣  PRICE RULES (if any)");
      const priceRuleCount = await client.query(
        `
                SELECT 
                    p.price_set_id,
                    p.id as price_id,
                    p.rules_count,
                    COUNT(pr.id) as actual_rules
                FROM price p
                LEFT JOIN price_rule pr ON p.id = pr.price_id
                WHERE p.price_set_id = ANY($1)
                AND p.deleted_at IS NULL
                GROUP BY p.price_set_id, p.id, p.rules_count
            `,
        [priceSetIds]
      );
      console.table(priceRuleCount.rows);
    } else {
      console.log("❌ CRITICAL: No price_set_ids found!\n");
    }

    console.log("\n=== SUMMARY ===");
    console.log(`Variants checked: ${variantLinks.rows.length}`);
    console.log(`Price sets found: ${priceSetIds.length}`);
    console.log(`Prices found: ${prices?.rows?.length || 0}`);

    if (prices?.rows?.length === 0 || priceSetIds.length === 0) {
      console.log("\n❌ ROOT CAUSE: Products are missing price configuration!");
      console.log(
        "   To fix: Add prices via Medusa Admin or run a migration script"
      );
    }
  } finally {
    await client.end();
  }
}

main().catch(console.error);
