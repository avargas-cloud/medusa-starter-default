import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../lib/accounting/month-close-auth";
import {
  updateDraftVendorCredit,
  VendorCreditError,
  type VendorCreditLineInput,
} from "../../../../lib/vendor-credits";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

function creditError(res: MedusaResponse, error: unknown) {
  if (error instanceof VendorCreditError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { id } = req.params as { id: string };
  const pool = getDbPool();
  const { rows: creditRows } = await pool.query(
    `SELECT * FROM vendor_credit WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const credit = creditRows[0];
  if (!credit) {
    return res.status(404).json({ error: "Vendor credit not found.", code: "not_found" });
  }
  const { rows: lines } = await pool.query(
    `SELECT * FROM vendor_credit_line WHERE credit_id = $1 AND deleted_at IS NULL ORDER BY sort`,
    [id]
  );
  const { rows: applications } = await pool.query(
    `SELECT * FROM vendor_credit_application WHERE credit_id = $1 ORDER BY applied_at DESC`,
    [id]
  );
  return res.json({ vendor_credit: credit, lines, applications });
}

/** PATCH { credit_date?, reason?, memo?, lines? }: only while draft. */
export async function PATCH(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { id } = req.params as { id: string };
  const body = req.body as {
    credit_date?: string;
    reason?: string | null;
    memo?: string | null;
    lines?: VendorCreditLineInput[];
  };

  const client = await getDbPool().connect();
  try {
    await updateDraftVendorCredit(client, id, body);
    return res.json({ id });
  } catch (error) {
    return creditError(res, error);
  } finally {
    client.release();
  }
}
