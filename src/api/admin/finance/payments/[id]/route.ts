import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { FINANCE_MODULE } from "../../../../../modules/finance";

/**
 * GET /admin/finance/payments/:id
 * Retrieves a single customer payment and its applications.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const id = req.params.id as string;

  try {
    const payment = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    return res.json({ payment });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
