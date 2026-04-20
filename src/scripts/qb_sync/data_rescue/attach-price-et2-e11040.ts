import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * One-off: attach a $238.00 USD price to the freshly-linked
 * ET2-E11040-24GLD variant (variant_01KPE2XS845DK7M2HC8M3CPM80) which was
 * updated by import-qb-item-by-sku but didn't get a price_set created
 * because the variant started without one.
 */
export default async function attachPriceEt2E11040({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pricing = container.resolve(Modules.PRICING) as unknown as {
    createPriceSets: (input: {
      prices: { amount: number; currency_code: string; rules: object }[];
    }) => Promise<{ id: string }>;
  };
  const remoteLink = container.resolve("remoteLink") as unknown as {
    create: (links: Record<string, unknown>) => Promise<void>;
  };

  const VARIANT_ID = "variant_01KPE2XS845DK7M2HC8M3CPM80";
  const AMOUNT = 23800; // $238.00 in cents

  logger.info(`Creating price_set ($${(AMOUNT / 100).toFixed(2)} USD)...`);
  const priceSet = await pricing.createPriceSets({
    prices: [{ amount: AMOUNT, currency_code: "usd", rules: {} }],
  });
  logger.info(`✅ price_set ${priceSet.id} created`);

  logger.info(`Linking price_set to variant ${VARIANT_ID}...`);
  await remoteLink.create({
    [Modules.PRODUCT]: { variant_id: VARIANT_ID },
    [Modules.PRICING]: { price_set_id: priceSet.id },
  });
  logger.info(`✅ Linked.`);
}
