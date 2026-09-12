import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { getBankTransfer } from "../../../../../lib/ledger";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../utils/db-pool";

/** GET /admin/accounting/transfers/:id → { transfer } | 404 GL_DOCUMENT_NOT_FOUND */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const client: PoolClient = await getDbPool().connect();
  try {
    const transfer = await getBankTransfer(client, req.params.id as string);
    if (!transfer)
      return res
        .status(404)
        .json({ error: "Transfer not found", code: "GL_DOCUMENT_NOT_FOUND" });
    return res.json({ transfer });
  } finally {
    client.release();
  }
}
