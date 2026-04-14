#!/usr/bin/env tsx
/**
 * Script to investigate and optionally clean up price_rules
 * that are blocking calculatePrices() from working
 */
import dotenv from "dotenv";
import pkg from "pg";
import readline from "readline";

const { Client } = pkg;
dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log("=== INVESTIGATING PRICE RULES ===\n");

    // Get all price_rules with their attributes
    const rules = await client.query(`
            SELECT 
                pr.id as rule_id,
                pr.price_id,
                pr.value as rule_value,
                prt.rule_attribute,
                prt.name as rule_type_name,
                p.amount as price_amount,
                p.currency_code,
                p.price_set_id
            FROM price_rule pr
            LEFT JOIN price_rule_type prt ON pr.rule_type_id = prt.id
            JOIN price p ON pr.price_id = p.id
            JOIN product_variant_price_set pvps ON p.price_set_id = pvps.price_set_id
            JOIN product_variant pv ON pvps.variant_id = pv.id
            WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
            AND p.deleted_at IS NULL
        `);

    if (rules.rows.length === 0) {
      console.log(
        "✅ No price_rules found! Prices should work with calculatePrices()\n"
      );
      await client.end();
      rl.close();
      return;
    }

    console.log(`⚠️  Found ${rules.rows.length} price_rules:\n`);
    console.table(rules.rows);

    console.log("\n🔍 ANALYSIS:");
    const rulesByAttribute = new Map<string, any[]>();
    rules.rows.forEach((rule) => {
      const attr = rule.rule_attribute || "unknown";
      if (!rulesByAttribute.has(attr)) {
        rulesByAttribute.set(attr, []);
      }
      rulesByAttribute.get(attr)!.push(rule);
    });

    rulesByAttribute.forEach((rules, attribute) => {
      console.log(`\n  ${attribute}:`);
      rules.forEach((r) => {
        console.log(
          `    - Price $${r.price_amount} requires ${attribute} = "${r.rule_value}"`
        );
      });
    });

    console.log("\n❌ PROBLEM:");
    console.log(
      "   These rules are blocking calculatePrices() from returning base prices."
    );
    console.log(
      "   Unless you provide the EXACT context they require, you get $0.00\n"
    );

    const answer = await question(
      "Do you want to DELETE all these price_rules? (yes/no): "
    );

    if (answer.toLowerCase() === "yes" || answer.toLowerCase() === "y") {
      const ruleIds = rules.rows.map((r) => r.rule_id);

      const deleteResult = await client.query(
        `
                DELETE FROM price_rule
                WHERE id = ANY($1)
                RETURNING id
            `,
        [ruleIds]
      );

      console.log(`\n✅ Deleted ${deleteResult.rowCount} price_rules`);
      console.log(
        "   Now calculatePrices() should work with just currency_code!\n"
      );

      // Update rules_count on prices
      const priceIds = [...new Set(rules.rows.map((r) => r.price_id))];
      await client.query(
        `
                UPDATE price
                SET rules_count = 0
                WHERE id = ANY($1)
            `,
        [priceIds]
      );

      console.log("✅ Updated price.rules_count to 0\n");
      console.log(
        "🎯 NEXT STEP: Test your backend endpoint - it should return $60.99!"
      );
    } else {
      console.log("\n⏭️  Skipped deletion. Rules remain in place.");
      console.log(
        "   To fix calculatePrices(), you must provide this context:"
      );
      rulesByAttribute.forEach((rules, attribute) => {
        const values = [...new Set(rules.map((r) => r.rule_value))];
        console.log(
          `   context: { ${attribute}: [${values.map((v) => `"${v}"`).join(", ")}] }`
        );
      });
    }
  } finally {
    await client.end();
    rl.close();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
