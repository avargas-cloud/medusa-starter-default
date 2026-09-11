import type { MedusaRequest } from "@medusajs/framework/http";

import { MEDUSA_REGION_ID } from "../config/region";

/**
 * Pricing context for the Store API — retail by default, wholesale when the
 * logged-in customer belongs to a group with a price list.
 *
 * Extracted from the three `/store/products*` routes that had it inline. Only
 * the new related-products route and the consolidated by-handle route use it
 * so far; the others keep their copy (out of scope, same behaviour).
 */
export const STORE_CURRENCY = "usd";
export const STORE_REGION_ID = MEDUSA_REGION_ID;

export interface StorePricingContext {
  currency_code: string;
  region_id: string;
  customer_group_id?: string[];
}

interface CustomerModuleLike {
  retrieveCustomer(
    id: string,
    config: { relations: string[] }
  ): Promise<{ groups?: { id: string }[] | null }>;
}

export const resolveStorePricingContext = async (
  req: MedusaRequest,
  logTag = "STORE-PRICING"
): Promise<{ context: StorePricingContext; customerId: string | null }> => {
  const context: StorePricingContext = {
    currency_code: STORE_CURRENCY,
    region_id: STORE_REGION_ID,
  };

  // auth_context is attached by Medusa's store auth middleware when the
  // publishable key request also carries a customer JWT/session.
  const customerId =
    (req as MedusaRequest & { auth_context?: { actor_id?: string } })
      .auth_context?.actor_id ?? null;
  if (!customerId) return { context, customerId };

  try {
    const customerModule = req.scope.resolve("customer") as CustomerModuleLike;
    const customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["groups"],
    });
    const groupIds = (customer.groups ?? []).map((g) => g.id);
    if (groupIds.length) {
      return {
        context: { ...context, customer_group_id: groupIds },
        customerId,
      };
    }
  } catch {
    console.warn(`[${logTag}] ⚠️  Could not fetch customer groups`);
  }
  return { context, customerId };
};
