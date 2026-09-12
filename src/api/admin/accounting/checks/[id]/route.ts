import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { getBankCheck, updateBankCheck } from "../../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
} from "../../../../../lib/ledger/documents/manual-http";
import {
  bankCheckBodySchema,
  toBankCheckInput,
} from "../../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * GET   /admin/accounting/checks/:id → { check } | 404 GL_DOCUMENT_NOT_FOUND
 * PATCH /admin/accounting/checks/:id — mismo body que el POST (sin `post`); reemplaza header
 *       + líneas de un `draft` y re-deriva `kind`/`total_cents`. 409 GL_DOCUMENT_NOT_DRAFT. → { check }
 */
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
    const check = await getBankCheck(client, req.params.id as string);
    if (!check)
      return res
        .status(404)
        .json({ error: "Check not found", code: "GL_DOCUMENT_NOT_FOUND" });
    return res.json({ check });
  } finally {
    client.release();
  }
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = bankCheckBodySchema.omit({ post: true }).safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    const check = await updateBankCheck(
      client,
      req.params.id as string,
      toBankCheckInput(parsed.data)
    );
    return res.json({ check });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
