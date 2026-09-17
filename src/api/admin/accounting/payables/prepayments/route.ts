import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import { listVendorPrepayments } from "../../../../../lib/bill-settlements/prepayments";

/** GET ?vendor_id=: every posted check/expense line of this vendor's prepayment (OtherCurrentAsset) account with money left to settle a bill. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { vendor_id } = req.query as Record<string, string | undefined>;
  if (!vendor_id) {
    return res.status(400).json({ error: "vendor_id is required.", code: "invalid_query" });
  }

  const prepayments = await listVendorPrepayments(getDbPool(), vendor_id);
  return res.json({ prepayments });
}
