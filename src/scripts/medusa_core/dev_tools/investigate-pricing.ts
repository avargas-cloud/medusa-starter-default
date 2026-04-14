import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function investigatePricing() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    console.log("=== 1. Checking price_set linkage ===");
    const priceSetCheck = await client.query(`
      SELECT 
        pv.id as variant_id,
        pv.sku,
        pv.title,
        pvps.price_set_id,
        COUNT(p.id) as price_count
      FROM product_variant pv
      LEFT JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
      LEFT JOIN price p ON pvps.price_set_id = p.price_set_id AND p.deleted_at IS NULL
      WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
      GROUP BY pv.id, pv.sku, pv.title, pvps.price_set_id
      LIMIT 3
    `);

    console.log(JSON.stringify(priceSetCheck.rows, null, 2));

    console.log("\n=== 2. Checking actual price records ===");
    const pricesCheck = await client.query(`
      SELECT 
        p.id,
        p.amount,
        p.currency_code,
        p.price_set_id,
        p.min_quantity,
        p.max_quantity
      FROM price p
      JOIN product_variant_price_set pvps ON p.price_set_id = pvps.price_set_id
      JOIN product_variant pv ON pvps.variant_id = pv.id
      WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
        AND p.deleted_at IS NULL
      LIMIT 5
    `);

    console.log(JSON.stringify(pricesCheck.rows, null, 2));

    console.log("\n=== 3. Checking regions ===");
    const regions = await client.query(`
      SELECT id, name, currency_code
      FROM region
      WHERE deleted_at IS NULL
      LIMIT 5
    `);

    console.log(JSON.stringify(regions.rows, null, 2));

    console.log("\n=== 4. Checking price rules (if any) ===");
    const priceRules = await client.query(`
      SELECT 
        pr.id,
        pr.attribute,
        pr.value,
        pr.price_set_id
      FROM price_rule pr
      JOIN product_variant_price_set pvps ON pr.price_set_id = pvps.price_set_id
      JOIN product_variant pv ON pvps.variant_id = pv.id
      WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
      LIMIT 10
    `);

    console.log(JSON.stringify(priceRules.rows, null, 2));
  } finally {
    await client.end();
  }
}

investigatePricing().catch(console.error);
