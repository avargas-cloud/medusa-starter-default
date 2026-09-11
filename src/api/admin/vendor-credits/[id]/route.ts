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
  deleteDraftVendorCredit,
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

/**
 * GET: header (+ `po_number`, `po_status`, `vendor_bill_number`,
 * `vendor_bill_reference_id`, `vendor_bill_status` of the linked documents —
 * read-only LEFT JOINs on the snapshotted ids), lines and applications as
 * sibling keys.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { id } = req.params as { id: string };
  const pool = getDbPool();
  const { rows: creditRows } = await pool.query(
    `SELECT vc.*,
            po.number AS po_number, po.status AS po_status,
            vb.number AS vendor_bill_number, vb.reference_id AS vendor_bill_reference_id,
            vb.status AS vendor_bill_status
       FROM vendor_credit vc
       LEFT JOIN purchase_order po ON po.id = vc.purchase_order_id AND po.deleted_at IS NULL
       LEFT JOIN vendor_bill vb ON vb.id = vc.vendor_bill_id AND vb.deleted_at IS NULL
      WHERE vc.id = $1 AND vc.deleted_at IS NULL`,
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
    `SELECT ca.*, vb.number AS vendor_bill_number
       FROM vendor_credit_application ca
       LEFT JOIN vendor_bill vb ON vb.id = ca.vendor_bill_id
      WHERE ca.credit_id = $1 ORDER BY ca.applied_at DESC`,
    [id]
  );
  return res.json({ vendor_credit: credit, lines, applications });
}

/** PATCH { credit_date?, reason?, memo?, vendor_bill_id?, lines? }: only while draft. */
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
    vendor_bill_id?: string | null;
    lines?: VendorCreditLineInput[];
  };
  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return res.status(400).json({ error: "lines must be an array.", code: "invalid_body" });
  }

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

/** DELETE: discards a DRAFT (soft-delete). Posted credits are voided, never deleted. */
export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { id } = req.params as { id: string };
  const client = await getDbPool().connect();
  try {
    await deleteDraftVendorCredit(client, id);
    return res.json({ id, deleted: true });
  } catch (error) {
    return creditError(res, error);
  } finally {
    client.release();
  }
}
