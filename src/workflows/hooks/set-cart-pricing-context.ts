import {
  addToCartWorkflow,
  updateLineItemInCartWorkflow,
  refreshCartItemsWorkflow,
} from "@medusajs/medusa/core-flows";
import { StepResponse } from "@medusajs/workflows-sdk";
import { Modules } from "@medusajs/utils";

/**
 * 💰 WHOLESALE PRICING HOOK — Gold Standard Medusa v2 Implementation
 *
 * This hook is called by `addToCartWorkflow` BEFORE calculating
 * prices for the items being added. By returning the customer's
 * group IDs in the context, the Pricing Module will use those
 * groups to select the correct price list (e.g., Wholesale pricing).
 *
 * @see https://docs.medusajs.com/resources/commerce-modules/pricing/price-calculation
 * @see GitHub issue #13990 for background on this approach
 */
addToCartWorkflow.hooks.setPricingContext(async ({ cart }, { container }) => {
  // 💰 SINGLE PRICE MODE GUARD (Backend)
  // When ENABLE_DYNAMIC_PRICING=false, everyone uses the same price list.
  // Skip customer group resolution — return empty context for default (retail) pricing.
  if (process.env.ENABLE_DYNAMIC_PRICING === "false") {
    console.log(
      "[PRICING-HOOK] 🔇 Single Price Mode — skipping group-based pricing"
    );
    return new StepResponse({});
  }

  // If cart has no customer, return empty context (guest pricing)
  if (!cart?.customer_id) {
    console.log("[PRICING-HOOK] 🛒 Guest cart — using default pricing");
    return new StepResponse({});
  }

  try {
    const customerModule = container.resolve(Modules.CUSTOMER);

    const customer = await customerModule.retrieveCustomer(cart.customer_id, {
      relations: ["groups"],
    });

    if (!customer.groups || customer.groups.length === 0) {
      console.log(
        `[PRICING-HOOK] 👤 Customer ${cart.customer_id} has no groups — using default pricing`
      );
      return new StepResponse({});
    }

    const groupIds = customer.groups.map((g: any) => g.id);
    console.log(
      `[PRICING-HOOK] 👑 Wholesale customer detected — groups: ${groupIds.join(", ")}`
    );

    // Return the customer_group_id context — this is what the Pricing Module
    // uses to match price list rules and apply the wholesale price
    return new StepResponse({
      customer_group_id: groupIds,
    });
  } catch (error: any) {
    console.warn(
      `[PRICING-HOOK] ⚠️ Could not resolve customer groups:`,
      error.message
    );
    return new StepResponse({});
  }
});

/**
 * 💰 WHOLESALE PRICING HOOK — updateLineItemInCartWorkflow
 *
 * Same logic as addToCartWorkflow. When a customer changes quantity in the cart,
 * Medusa recalculates the unit_price via this workflow. Without this hook it
 * resets to retail pricing. This ensures the wholesale price is preserved.
 */
updateLineItemInCartWorkflow.hooks.setPricingContext(
  async ({ cart }, { container }) => {
    // 💰 SINGLE PRICE MODE GUARD (Backend)
    if (process.env.ENABLE_DYNAMIC_PRICING === "false") {
      return new StepResponse({});
    }

    if (!cart?.customer_id) {
      return new StepResponse({});
    }

    try {
      const customerModule = container.resolve(Modules.CUSTOMER);
      const customer = await customerModule.retrieveCustomer(cart.customer_id, {
        relations: ["groups"],
      });

      if (!customer.groups || customer.groups.length === 0) {
        return new StepResponse({});
      }

      const groupIds = customer.groups.map((g: any) => g.id);
      console.log(
        `[PRICING-HOOK-UPDATE] 👑 Wholesale qty update — groups: ${groupIds.join(", ")}`
      );

      return new StepResponse({
        customer_group_id: groupIds,
      });
    } catch (error: any) {
      console.warn(
        `[PRICING-HOOK-UPDATE] ⚠️ Could not resolve customer groups:`,
        error.message
      );
      return new StepResponse({});
    }
  }
);

/**
 * 💰 WHOLESALE PRICING HOOK — refreshCartItemsWorkflow
 *
 * Called when /reprice endpoint runs refreshCartItemsWorkflow(force_refresh: true).
 *
 * READS additional_data.force_retail (set by /reprice endpoint):
 *   - true  = logout scenario → return {} → retail prices (ignores cart's customer_id in DB)
 *   - false = login scenario  → look up customer group → wholesale prices
 */
refreshCartItemsWorkflow.hooks.setPricingContext(
  async ({ cart_id, additional_data }, { container }) => {
    if (process.env.ENABLE_DYNAMIC_PRICING === "false") {
      return new StepResponse({});
    }

    // LOGOUT path: force_retail=true → apply retail regardless of cart customer_id
    if ((additional_data as any)?.force_retail === true) {
      console.log(
        `[PRICING-HOOK-REFRESH] 🏷️ force_retail=true — applying retail prices`
      );
      return new StepResponse({});
    }

    // Fetch the cart to get its customer_id
    const cartModule = container.resolve(Modules.CART);
    const cart = (await cartModule.retrieveCart(cart_id as string, {})) as any;

    if (!cart?.customer_id) {
      console.log(
        "[PRICING-HOOK-REFRESH] 🛒 Guest cart — using default pricing"
      );
      return new StepResponse({});
    }

    try {
      const customerModule = container.resolve(Modules.CUSTOMER);
      const customer = await customerModule.retrieveCustomer(cart.customer_id, {
        relations: ["groups"],
      });

      if (!customer.groups || customer.groups.length === 0) {
        return new StepResponse({});
      }

      const groupIds = customer.groups.map((g: any) => g.id);
      console.log(
        `[PRICING-HOOK-REFRESH] 👑 Wholesale reprice — groups: ${groupIds.join(", ")}`
      );

      return new StepResponse({
        customer_group_id: groupIds,
      });
    } catch (error: any) {
      console.warn(
        `[PRICING-HOOK-REFRESH] ⚠️ Could not resolve customer groups:`,
        error.message
      );
      return new StepResponse({});
    }
  }
);
