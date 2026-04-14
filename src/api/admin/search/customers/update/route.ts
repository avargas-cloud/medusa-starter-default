import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { updateSingleCustomerWorkflow } from "../../../../../workflows/update-single-customer";

/**
 * INCREMENTAL SYNC ENDPOINT: Update Single Customer
 *
 * Used by auto-sync middleware to update only the changed customer.
 */

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { customerId } = req.body as { customerId: string };

  if (!customerId) {
    return res.status(400).json({
      error: "customerId is required",
    });
  }

  try {
    const { result } = (await updateSingleCustomerWorkflow(req.scope).run({
      input: { customerId },
    })) as {
      result: {
        success: boolean;
        customerId?: string;
        email?: string;
        reason?: string;
      };
    };

    return res.json({
      success: result.success,
      customerId: result.customerId,
      email: result.email,
    });
  } catch (error: any) {
    console.error("[MEILI-UPDATE-CUSTOMER] Error:", error);
    return res.status(500).json({
      error: "Failed to update customer in MeiliSearch",
      details: (error as Error).message,
    });
  }
};

// Middleware to protect this route (admin only)
export const config = {
  auth: true,
};
