#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

/**
 * 🧪 Test Wholesale Pricing Flow
 *
 * This script simulates the exact flow that happens when a logged-in wholesale
 * customer views a product page. It helps identify where the pricing breaks.
 *
 * Run: npx tsx src/scripts/debug/test-wholesale-pricing.ts [customer_email] [product_id]
 */

async function testWholesalePricing() {
  const customerEmail = process.argv[2] || "a.vargas@ecopowertech.com";
  const productId = process.argv[3] || "product_01KGAX7RD0E6AS8JDARPEED795";

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    console.log("🔍 WHOLESALE PRICING DEBUG FLOW\n");
    console.log(`Testing with customer: ${customerEmail}`);
    console.log(`Product: ${productId}\n`);

    // STEP 1: Get customer and their groups
    console.log("═══ STEP 1: Customer Lookup ═══");
    const customerQuery = await client.query(
      `
            SELECT 
                c.id as customer_id,
                c.email,
                c.first_name,
                c.last_name
            FROM customer c
            WHERE c.email = $1
              AND c.deleted_at IS NULL
        `,
      [customerEmail]
    );

    if (customerQuery.rows.length === 0) {
      console.log(`❌ Customer not found: ${customerEmail}`);
      return;
    }

    const customer = customerQuery.rows[0];
    console.log(`✅ Customer found: ${customer.customer_id}`);
    console.log(`   Name: ${customer.first_name} ${customer.last_name}`);

    // Get customer groups
    const groupsQuery = await client.query(
      `
            SELECT 
                cg.id as group_id,
                cg.name as group_name
            FROM customer_group cg
            JOIN customer_group_customer cgc ON cg.id = cgc.customer_group_id
            WHERE cgc.customer_id = $1
              AND cg.deleted_at IS NULL
        `,
      [customer.customer_id]
    );

    console.log(`\n👥 Customer Groups (${groupsQuery.rows.length}):`);
    if (groupsQuery.rows.length === 0) {
      console.log("   ⚠️  No groups assigned!");
    } else {
      groupsQuery.rows.forEach((g) => {
        console.log(`   - ${g.group_name} (${g.group_id})`);
      });
    }

    const customerGroupIds = groupsQuery.rows.map((g) => g.group_id);

    // STEP 2: Check price lists
    console.log("\n═══ STEP 2: Price Lists ═══");
    const priceListsQuery = await client.query(`
            SELECT 
                pl.id as price_list_id,
                pl.title,
                pl.description,
                pl.status,
                COUNT(DISTINCT plr.id) as rules_count
            FROM price_list pl
            LEFT JOIN price_list_rule plr ON pl.id = plr.price_list_id
            WHERE pl.deleted_at IS NULL
            GROUP BY pl.id, pl.title, pl.description, pl.status
            ORDER BY pl.created_at DESC
        `);

    console.log(`📋 Price Lists (${priceListsQuery.rows.length}):`);
    priceListsQuery.rows.forEach((pl) => {
      console.log(`   - ${pl.title} (${pl.price_list_id})`);
      console.log(`     Status: ${pl.status}, Rules: ${pl.rules_count}`);
    });

    // STEP 3: Check price list rules
    console.log("\n═══ STEP 3: Price List Rules ═══");
    const rulesQuery = await client.query(`
            SELECT 
                pl.title as price_list_title,
                plr.id as rule_id,
                plr.attribute,
                plr.value
            FROM price_list_rule plr
            JOIN price_list pl ON plr.price_list_id = pl.id
            WHERE pl.deleted_at IS NULL
            ORDER BY pl.title
        `);

    console.log(`🎯 Price List Rules (${rulesQuery.rows.length}):`);
    if (rulesQuery.rows.length === 0) {
      console.log("   ⚠️  No price list rules found!");
      console.log("   This means price lists won't apply to customer groups!");
    } else {
      rulesQuery.rows.forEach((r) => {
        console.log(`   - ${r.price_list_title}: ${r.attribute} = ${r.value}`);
      });
    }

    // STEP 4: Get product variants
    console.log("\n═══ STEP 4: Product Variants ═══");
    const variantsQuery = await client.query(
      `
            SELECT 
                pv.id as variant_id,
                pv.title,
                pv.sku,
                pvps.price_set_id
            FROM product_variant pv
            LEFT JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
            WHERE pv.product_id = $1
              AND pv.deleted_at IS NULL
            LIMIT 3
        `,
      [productId]
    );

    console.log(`📦 Variants (${variantsQuery.rows.length}):`);
    variantsQuery.rows.forEach((v) => {
      console.log(`   - ${v.sku}: ${v.title}`);
      console.log(`     Price Set: ${v.price_set_id || "MISSING!"}`);
    });

    if (variantsQuery.rows.length === 0) {
      console.log("   ❌ No variants found!");
      return;
    }

    // STEP 5: Check prices for the first variant
    const firstVariant = variantsQuery.rows[0];
    console.log(`\n═══ STEP 5: Prices for ${firstVariant.sku} ═══`);

    if (!firstVariant.price_set_id) {
      console.log("❌ Variant has no price_set_id!");
      return;
    }

    const pricesQuery = await client.query(
      `
            SELECT 
                p.id,
                p.amount,
                p.currency_code,
                p.min_quantity,
                p.max_quantity,
                p.price_list_id,
                pl.title as price_list_title
            FROM price p
            LEFT JOIN price_list pl ON p.price_list_id = pl.id
            WHERE p.price_set_id = $1
              AND p.deleted_at IS NULL
            ORDER BY p.price_list_id NULLS FIRST
        `,
      [firstVariant.price_set_id]
    );

    console.log(`💰 Prices found (${pricesQuery.rows.length}):`);
    pricesQuery.rows.forEach((p) => {
      const type = p.price_list_id ? `List: ${p.price_list_title}` : "BASE";
      console.log(
        `   - $${parseFloat(p.amount).toFixed(2)} ${p.currency_code.toUpperCase()} (${type})`
      );
    });

    // STEP 6: Determine which price should apply
    console.log("\n═══ STEP 6: Price Selection Logic ═══");

    const basePrices = pricesQuery.rows.filter((p) => !p.price_list_id);
    const listPrices = pricesQuery.rows.filter((p) => p.price_list_id);

    console.log(`\n📊 Price Breakdown:`);
    console.log(`   Base Prices: ${basePrices.length}`);
    console.log(`   Price List Prices: ${listPrices.length}`);

    if (customerGroupIds.length > 0) {
      console.log(
        `\n🎯 Customer has groups, checking for matching price lists...`
      );

      // Check if any price list rules match customer groups
      const matchingRules = await client.query(
        `
                SELECT 
                    plr.id,
                    plr.price_list_id,
                    plr.attribute,
                    plr.value,
                    pl.title as price_list_title
                FROM price_list_rule plr
                JOIN price_list pl ON plr.price_list_id = pl.id
                WHERE plr.attribute = 'customer_group_id'
                  AND plr.value = ANY($1::text[])
                  AND pl.deleted_at IS NULL
            `,
        [customerGroupIds]
      );

      if (matchingRules.rows.length > 0) {
        console.log(
          `   ✅ Found ${matchingRules.rows.length} matching price list(s):`
        );
        matchingRules.rows.forEach((r) => {
          console.log(`      - ${r.price_list_title} (${r.price_list_id})`);
        });

        // Check if these price lists have prices for this variant
        const applicablePrices = listPrices.filter((p) =>
          matchingRules.rows.some((r) => r.price_list_id === p.price_list_id)
        );

        if (applicablePrices.length > 0) {
          console.log(
            `\n   💵 SHOULD SEE: $${parseFloat(applicablePrices[0].amount).toFixed(2)}`
          );
          console.log(`      (from ${applicablePrices[0].price_list_title})`);
        } else {
          console.log(
            `\n   ⚠️  Price lists match, but NO PRICES found in those lists!`
          );
          console.log(
            `   WILL SEE: Base price $${basePrices.length > 0 ? parseFloat(basePrices[0].amount).toFixed(2) : "N/A"}`
          );
        }
      } else {
        console.log(`   ⚠️  No price list rules match customer groups!`);
        console.log(`   Customer groups: ${customerGroupIds.join(", ")}`);
        console.log(
          `   WILL SEE: Base price $${basePrices.length > 0 ? parseFloat(basePrices[0].amount).toFixed(2) : "N/A"}`
        );
      }
    } else {
      console.log(`\n   ℹ️  Customer has no groups`);
      console.log(
        `   WILL SEE: Base price $${basePrices.length > 0 ? parseFloat(basePrices[0].amount).toFixed(2) : "N/A"}`
      );
    }

    // STEP 7: Summary
    console.log("\n═══ SUMMARY ═══");
    console.log(`✅ Customer: ${customer.email}`);
    console.log(
      `✅ Groups: ${customerGroupIds.length > 0 ? groupsQuery.rows.map((g) => g.group_name).join(", ") : "None"}`
    );
    console.log(`✅ Product: ${productId}`);
    console.log(`✅ Variants: ${variantsQuery.rows.length}`);
    console.log(`✅ Base Prices: ${basePrices.length}`);
    console.log(`✅ Price List Prices: ${listPrices.length}`);

    console.log("\n🔍 DIAGNOSIS:");
    if (customerGroupIds.length === 0) {
      console.log("❌ ISSUE: Customer has no groups assigned!");
      console.log('   → Add customer to "Wholesale" group');
    } else if (listPrices.length === 0) {
      console.log("❌ ISSUE: No wholesale prices exist!");
      console.log("   → Run: npx medusa exec ./add-wholesale-prices.ts");
    } else if (rulesQuery.rows.length === 0) {
      console.log(
        "❌ ISSUE: Price lists have no rules linking them to customer groups!"
      );
      console.log("   → Run: npx medusa exec ./setup-gold-standard-pricing.ts");
    } else {
      const matchingRules = await client.query(
        `
                SELECT COUNT(*) as count
                FROM price_list_rule plr
                WHERE plr.attribute = 'customer_group_id'
                  AND plr.value = ANY($1::text[])
            `,
        [customerGroupIds]
      );

      if (matchingRules.rows[0].count === "0") {
        console.log(
          "❌ ISSUE: Customer groups don't match any price list rules!"
        );
        console.log(`   Customer groups: ${customerGroupIds.join(", ")}`);
        console.log("   → Verify price list rules are set up correctly");
      } else {
        console.log("✅ Everything looks correct in database!");
        console.log("   → Issue might be in API route or frontend");
        console.log("   → Check backend logs when accessing the page");
      }
    }
  } finally {
    await client.end();
  }
}

testWholesalePricing().catch(console.error);
