import dotenv from "dotenv";
import pkg from "pg";
const { Client } = pkg;

dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log("=== INVESTIGATING PRICE RULES ===\n");

    // Get prices for our product
    const prices = await client.query(`
            SELECT p.id, p.amount, p.currency_code, p.rules_count, p.price_set_id
            FROM price p
            WHERE p.price_set_id IN (
                SELECT pvps.price_set_id 
                FROM product_variant pv
                JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
                WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
            )
            AND p.deleted_at IS NULL
        `);

    console.log("📋 Prices found:");
    console.table(prices.rows);

    if (prices.rows.length > 0) {
      console.log("\n🔍 Checking price rules...");

      const priceIds = prices.rows.map((p) => p.id);

      const rules = await client.query(
        `
                SELECT 
                    pr.id as rule_id,
                    pr.price_id,
                    pr.price_set_id,
                    pr.rule_type_id,
                    pr.value as rule_value,
                    prt.rule_attribute,
                    prt.name as rule_type_name,
                    p.amount as price_amount
                FROM price_rule pr
                LEFT JOIN price_rule_type prt ON pr.rule_type_id = prt.id
                JOIN price p ON pr.price_id = p.id
                WHERE pr.price_id = ANY($1)
            `,
        [priceIds]
      );

      if (rules.rows.length > 0) {
        console.log("\n⚠️  FOUND PRICE RULES:");
        console.table(rules.rows);

        console.log("\n🎯 ANALYSIS:");
        rules.rows.forEach((rule) => {
          console.log(
            `  - Price $${rule.price_amount} requires: ${rule.rule_attribute} = "${rule.rule_value}"`
          );
        });

        console.log(
          "\n❌ PROBLEM: calculatePrices() expects these context values but we may not be providing them!"
        );
        console.log(
          "   Solution: Either provide the context OR remove the rules for base prices."
        );
      } else {
        console.log("✅ No price rules found - prices should work!");
      }
    }

    // Check price lists
    console.log("\n💰 Checking Price Lists...");
    const priceLists = await client.query(`
            SELECT id, title, status, type, starts_at, ends_at
            FROM price_list
            WHERE deleted_at IS NULL
        `);

    if (priceLists.rows.length > 0) {
      console.table(priceLists.rows);

      // Check if any prices are linked to price lists
      const priceListPrices = await client.query(`
                SELECT p.id, p.amount, p.price_list_id, pl.title as price_list_title
                FROM price p
                JOIN price_list pl ON p.price_list_id = pl.id
                WHERE p.price_set_id IN (
                    SELECT pvps.price_set_id 
                    FROM product_variant pv
                    JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
                    WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
                )
                AND p.deleted_at IS NULL
            `);

      if (priceListPrices.rows.length > 0) {
        console.log("\n🏷️  Prices with Price Lists:");
        console.table(priceListPrices.rows);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch(console.error);
