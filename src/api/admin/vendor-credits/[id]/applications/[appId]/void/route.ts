import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../../../lib/accounting/month-close-auth";
import {
  voidVendorCreditApplication,
  VendorCreditError,
} from "../../../../../../../lib/vendor-credits";

/** POST: releases one application (the bill's balance grows back). */
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

  const { appId } = req.params as { appId: string };
  const client = await getDbPool().connect();
  try {
    await voidVendorCreditApplication(client, appId, actorId);
    return res.json({ id: appId });
  } catch (error) {
    if (error instanceof VendorCreditError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    client.release();
  }
}
