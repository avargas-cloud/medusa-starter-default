import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../lib/accounting/month-close-auth";

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { id } = req.params as { id: string };
  const pool = getDbPool();
  const { rows: paymentRows } = await pool.query(
    `SELECT * FROM vendor_bill_payment WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const payment = paymentRows[0];
  if (!payment) {
    return res.status(404).json({ error: "Bill payment not found.", code: "not_found" });
  }
  const { rows: allocations } = await pool.query(
    `SELECT * FROM vendor_bill_payment_allocation WHERE payment_id = $1 ORDER BY created_at`,
    [id]
  );
  return res.json({ bill_payment: payment, allocations });
}
