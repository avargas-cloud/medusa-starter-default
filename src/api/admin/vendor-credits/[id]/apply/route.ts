import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import { applyVendorCreditToBill, VendorCreditError } from "../../../../../lib/vendor-credits";

/** POST { vendor_bill_id, amount_cents }: apply (part of) this credit to a bill. */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { id } = req.params as { id: string };
  const body = req.body as { vendor_bill_id?: string; amount_cents?: number };
  if (!body.vendor_bill_id || typeof body.amount_cents !== "number") {
    return res.status(400).json({
      error: "vendor_bill_id and amount_cents are required.",
      code: "invalid_body",
    });
  }

  const client = await getDbPool().connect();
  try {
    const application = await applyVendorCreditToBill(client, {
      creditId: id,
      vendorBillId: body.vendor_bill_id,
      amountCents: body.amount_cents,
      actorId,
    });
    return res.status(201).json({ application });
  } catch (error) {
    if (error instanceof VendorCreditError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    client.release();
  }
}
