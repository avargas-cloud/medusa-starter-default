import { MedusaContainer } from "@medusajs/framework/types";
import { createPromotionsWorkflow } from "@medusajs/medusa/core-flows";

export default async function createPredefinedPromotions({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve("logger");
  const promotionModule = container.resolve("promotion");

  const percents = [2.5, 5, 7.5, 10, 15, 20, 25, 30, 40, 50];
  const toCreate: any[] = [];

  for (const pct of percents) {
    const code = "ORDER-DISCOUNT-" + pct + "%";

    // Check if exists
    const existing = await promotionModule.listPromotions({ code });
    if (existing.length > 0) {
      logger.info("Promotion " + code + " already exists, skipping.");
      continue;
    }

    toCreate.push({
      code,
      type: "standard",
      is_automatic: false,
      application_method: {
        type: "percentage",
        target_type: "order",
        value: pct,
        target_rules: [],
        buy_rules: [],
      },
      rules: [],
    });
  }

  if (toCreate.length > 0) {
    logger.info("Creating " + toCreate.length + " promotions...");
    try {
      await createPromotionsWorkflow(container).run({
        input: { promotionsData: toCreate },
      });
      logger.info("Successfully created predefined promotions.");
    } catch (e: any) {
      logger.error("Failed to create promotions: " + e.message);
    }
  } else {
    logger.info("No new promotions needed to be created.");
  }
}
