import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { randomUUID } from "crypto";

const WHOLESALE_PRICE_LIST_ID =
  process.env.WHOLESALE_PRICE_LIST_ID ?? "plist_01KFTSDZZNTQRSYNMB4YST1HYA";

export type WholesalePriceInput = {
  variant_id: string;
  wholesale_price: number;
};

export type ApplyWholesalePricesStepInput = {
  prices: WholesalePriceInput[];
  currency_code?: string;
};

export const applyWholesalePricesStep = createStep(
  "apply-wholesale-prices-step",
  async (input: ApplyWholesalePricesStepInput, { container }) => {
    const logger = container.resolve("logger");
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const knex = (container as any).resolve("__pg_connection__");
    const currency = (input.currency_code ?? "usd").toLowerCase();

    if (input.prices.length === 0) {
      return new StepResponse({ applied: 0 }, null);
    }

    const variantIds = input.prices.map((p) => p.variant_id);
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "price_set.id"],
      filters: { id: variantIds },
    });

    const priceSetByVariant = new Map<string, string>();
    for (const v of variants as Array<{
      id: string;
      price_set: { id: string } | null;
    }>) {
      if (v.price_set?.id) priceSetByVariant.set(v.id, v.price_set.id);
    }

    let applied = 0;
    for (const p of input.prices) {
      const priceSetId = priceSetByVariant.get(p.variant_id);
      if (!priceSetId) {
        logger.warn(
          `[applyWholesalePricesStep] variant ${p.variant_id} has no price_set; skipping wholesale price`
        );
        continue;
      }

      const priceId = `price_${randomUUID().replace(/-/g, "")}`;

      await knex.raw(
        `INSERT INTO price (
          id, price_set_id, price_list_id, currency_code,
          amount, raw_amount, min_quantity, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?::jsonb, NULL, NOW(), NOW())`,
        [
          priceId,
          priceSetId,
          WHOLESALE_PRICE_LIST_ID,
          currency,
          p.wholesale_price,
          JSON.stringify({ value: String(p.wholesale_price), precision: 20 }),
        ]
      );
      applied++;
    }

    return new StepResponse({ applied }, null);
  }
);
