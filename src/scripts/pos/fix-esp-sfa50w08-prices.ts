import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { randomUUID } from "crypto";

const WHOLESALE_PRICE_LIST_ID = "plist_01KFTSDZZNTQRSYNMB4YST1HYA";
const PRODUCT_ID = "prod_01KQ5J6RVZ8TTNH1QZD6FQBPSV";

const VARIANTS = [
  { id: "variant_01KQ5J6RVZ8N6N9H1NH1MCF07S", sku: "ESP-SFA50W0830" },
  { id: "variant_01KQ5J6RVZWA6WBV0QC1M5DJ36", sku: "ESP-SFA50W0840" },
  { id: "variant_01KQ5J6RVZHAQRV8DG9YBRW2Q2", sku: "ESP-SFA50W0860" },
];

function genId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export default async function fixEspSfa50w08Prices({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = (container as any).resolve("__pg_connection__");

  logger.info("=".repeat(60));
  logger.info("Adding retail + wholesale prices for ESP-SFA50W08 variants");
  logger.info("=".repeat(60));

  for (const v of VARIANTS) {
    logger.info(`\nProcessing ${v.sku} (${v.id})`);

    // Create price set (table has just id + timestamps)
    const priceSetId = genId("pset");
    await knex.raw(
      `INSERT INTO price_set (id, created_at, updated_at) VALUES (?, NOW(), NOW())`,
      [priceSetId]
    );
    logger.info(`  Price set: ${priceSetId}`);

    // Link variant → price set
    await knex.raw(
      `INSERT INTO product_variant_price_set (variant_id, price_set_id, id)
       VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [v.id, priceSetId, genId("pvps")]
    );
    logger.info(`  Linked variant → price_set`);

    // Retail price $56.75
    await knex.raw(
      `INSERT INTO price (id, price_set_id, currency_code, amount, raw_amount, created_at, updated_at)
       VALUES (?, ?, 'usd', 56.75, ?::jsonb, NOW(), NOW())`,
      [genId("price"), priceSetId, JSON.stringify({ value: "56.75", precision: 20 })]
    );
    logger.info(`  ✅ Retail  $56.75 USD`);

    // Wholesale price $51.99
    await knex.raw(
      `INSERT INTO price (id, price_set_id, price_list_id, currency_code, amount, raw_amount, created_at, updated_at)
       VALUES (?, ?, ?, 'usd', 51.99, ?::jsonb, NOW(), NOW())`,
      [genId("price"), priceSetId, WHOLESALE_PRICE_LIST_ID, JSON.stringify({ value: "51.99", precision: 20 })]
    );
    logger.info(`  ✅ Wholesale $51.99 USD`);
  }

  // Verify
  logger.info("\n" + "=".repeat(60));
  logger.info("Verification:");
  const rows = await knex.raw(
    `SELECT pv.sku, p.amount, p.currency_code,
            CASE WHEN p.price_list_id IS NULL THEN 'retail' ELSE 'wholesale' END as type
     FROM product_variant pv
     JOIN product_variant_price_set pvps ON pvps.variant_id = pv.id
     JOIN price p ON p.price_set_id = pvps.price_set_id
     WHERE pv.product_id = ?
     ORDER BY pv.sku, p.amount`,
    [PRODUCT_ID]
  );

  for (const row of rows.rows) {
    logger.info(`  ${row.sku} | $${row.amount} ${row.currency_code} (${row.type})`);
  }
  logger.info("=".repeat(60));
}
