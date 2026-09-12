import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  AccountWriteError,
  patchAccount,
  validateName,
  type PatchAccountInput,
} from "../../../../../lib/ledger/reports/accounts-write";
import {
  accessFailure,
  assertOwner,
} from "../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * PATCH { name?, account_number?, is_active?, description? } — owner-only.
 * A rename cascades to descendants; deactivating with a balance → 409
 * `ACCOUNT_HAS_BALANCE`. There is deliberately no DELETE.
 */
export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const listId = String(req.params.listId ?? "").trim();
  if (!listId) {
    return res
      .status(400)
      .json({ error: "list_id is required", code: "INVALID_LIST_ID" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  const client = await getDbPool().connect();
  try {
    const input: PatchAccountInput = {};
    if (body.name !== undefined) input.name = validateName(body.name);
    if (body.account_number !== undefined) {
      input.account_number =
        typeof body.account_number === "string" && body.account_number.trim()
          ? body.account_number.trim()
          : null;
    }
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== "boolean") {
        throw new AccountWriteError(
          "INVALID_IS_ACTIVE",
          400,
          "is_active must be boolean"
        );
      }
      input.is_active = body.is_active;
    }
    if (body.description !== undefined) {
      input.description =
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : null;
    }
    await client.query("BEGIN");
    await patchAccount(client, listId, input);
    await client.query("COMMIT");
    return res.json({ list_id: listId, ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof AccountWriteError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    client.release();
  }
}
