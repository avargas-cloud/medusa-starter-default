import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";

export type LinkQbVendorStepInput = {
  links: Array<{
    variant_id: string;
    qb_vendor_id: string;
  }>;
};

export const linkQbVendorStep = createStep(
  "link-qb-vendor-step",
  async (input: LinkQbVendorStepInput, { container }) => {
    const logger = container.resolve("logger");
    const link = container.resolve(ContainerRegistrationKeys.LINK);

    if (input.links.length === 0) {
      return new StepResponse({ created: 0 }, null);
    }

    const definitions = input.links.map((l) => ({
      [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: l.qb_vendor_id },
      [Modules.PRODUCT]: { product_variant_id: l.variant_id },
    }));

    try {
      await link.create(definitions);
    } catch (err: any) {
      logger.warn(
        `[linkQbVendorStep] link.create failed (${err.message}) — continuing`
      );
    }

    return new StepResponse({ created: definitions.length }, null);
  }
);
