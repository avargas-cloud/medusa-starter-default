/**
 * Verify wholesale prices for 10 random SKUs
 * Run: yarn medusa exec ./src/scripts/verify/verify-wholesale-10skus.ts
 */
import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { ContainerRegistrationKeys } from "@medusajs/utils";

function smartRound(price: number): number {
  const dollars = Math.floor(price);
  const cents = price - dollars;
  if (cents < 0.25) return dollars + 0.25;
  if (cents < 0.5) return dollars + 0.5;
  if (cents < 0.75) return dollars + 0.75;
  return dollars + 0.99;
}

export default async function verifyWholesale10Skus({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pricingService: any = container.resolve(Modules.PRICING);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // 1. Get the Wholesale price list ID
  const priceLists = await pricingService.listPriceLists({
    title: ["Wholesale Pricing"],
  });
  const wholesalePriceListId = priceLists[0]?.id;
  if (!wholesalePriceListId) {
    logger.error("❌ Wholesale price list not found");
    return;
  }

  // 2. Get all wholesale prices (indexed by price_set_id)
  const allWholesale = await pricingService.listPrices({
    price_list_id: [wholesalePriceListId],
  });
  const wholesaleByPriceSet = new Map<string, any>();
  for (const p of allWholesale) wholesaleByPriceSet.set(p.price_set_id, p);

  // 3. Get variants with price sets
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "prices.amount",
      "prices.currency_code",
      "prices.price_list_id",
      "price_set.id",
    ],
  });

  // Filter variants that have both retail AND wholesale, pick 10 random
  const withPrices = variants.filter(
    (v: any) =>
      v.sku && v.price_set?.id && wholesaleByPriceSet.has(v.price_set.id)
  );
  const shuffled = withPrices.sort(() => Math.random() - 0.5).slice(0, 10);

  logger.info(
    `\n🔍 Verifying 10 random SKUs (out of ${withPrices.length} with wholesale prices):\n`
  );
  logger.info(`${"─".repeat(90)}`);
  logger.info(
    `${"SKU".padEnd(28)} ${"Retail".padStart(8)} ${"Wholesale".padStart(10)} ${"Expected WS".padStart(12)} ${"plist_id OK".padStart(12)} ${"Status".padStart(8)}`
  );
  logger.info(`${"─".repeat(90)}`);

  let allOk = true;

  for (const variant of shuffled) {
    const usdPrices = (variant.prices || []).filter(
      (p: any) => p.currency_code === "usd" && !p.price_list_id
    );
    const retail =
      usdPrices.length > 0
        ? usdPrices.reduce((max: any, p: any) =>
            p.amount > max.amount ? p : max
          )
        : null;

    const wsPrice = wholesaleByPriceSet.get(variant.price_set.id);

    const retailAmt = retail?.amount ?? 0;
    const wsAmt = wsPrice?.amount ?? 0;
    const expectedWs = smartRound(retailAmt * 0.9);
    const plIdOk = wsPrice?.price_list_id === wholesalePriceListId;
    const wsOk = Math.abs(wsAmt - expectedWs) < 0.01;

    const status = plIdOk && wsOk ? "✅ OK" : "❌ FAIL";
    if (!plIdOk || !wsOk) allOk = false;

    logger.info(
      `${(variant.sku || "?").padEnd(28)} ` +
        `${"$" + retailAmt.toFixed(2)}`.padStart(8) +
        " " +
        `${"$" + wsAmt.toFixed(2)}`.padStart(10) +
        " " +
        `${"$" + expectedWs.toFixed(2)}`.padStart(12) +
        " " +
        `${plIdOk ? "✅ yes" : "❌ NO"}`.padStart(12) +
        " " +
        status
    );
  }

  logger.info(`${"─".repeat(90)}`);
  logger.info(
    allOk
      ? "\n✅ ALL 10 SKUs VERIFIED CORRECTLY!"
      : "\n❌ SOME SKUs HAVE ISSUES — check rows marked FAIL above"
  );
}
