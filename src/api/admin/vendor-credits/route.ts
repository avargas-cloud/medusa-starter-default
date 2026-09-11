import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../lib/accounting/month-close-auth";
import {
  createDraftVendorCredit,
  buildListVendorCreditsQuery,
  VendorCreditError,
  type VendorCreditLineInput,
} from "../../../lib/vendor-credits";

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
 * GET: list vendor credits, filterable by vendor_id/status, free-text `q`
 * (ILIKE over number/vendor name/reason/memo/PO number/bill number). Each
 * row carries `applied_to` — the credit's active applications joined to the
 * bill's number — plus `po_number` / `vendor_bill_number` of the linked
 * documents, so the POS row renders without a second round trip.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { vendor_id, status, q, limit, offset } = req.query as Record<
    string,
    string | undefined
  >;
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;

  const { sql, params } = buildListVendorCreditsQuery({
    vendorId: vendor_id,
    status,
    q,
    limit: lim,
    offset: off,
  });

  const pool = getDbPool();
  const { rows } = await pool.query(sql, params);
  return res.json({ vendor_credits: rows });
}

/**
 * POST { vendor_id, credit_date, reason?, memo?, purchase_order_id?,
 *        vendor_bill_id?, lines }: creates a draft.
 * `lines` is REQUIRED and non-empty (owner rule 2026-09-11 — the POS
 * collects PO + lines locally and creates once). With `purchase_order_id`
 * every product line names a PO line and stays within what was received
 * (`exceeds_returnable`); without it, product lines are refused
 * (`product_line_requires_po`).
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const body = req.body as {
    vendor_id?: string;
    credit_date?: string;
    reason?: string | null;
    memo?: string | null;
    purchase_order_id?: string | null;
    vendor_bill_id?: string | null;
    lines?: VendorCreditLineInput[];
  };
  if (!body.vendor_id || !body.credit_date || !Array.isArray(body.lines)) {
    return res.status(400).json({
      error: "vendor_id, credit_date and a lines array are required.",
      code: "invalid_body",
    });
  }

  // A dedicated client, not the pool: the lib function issues its own
  // BEGIN/COMMIT, and `pool.query()` hands each call a DIFFERENT pooled
  // connection — that would silently split the transaction across sockets.
  const client = await getDbPool().connect();
  try {
    const created = await createDraftVendorCredit(client, {
      vendor_id: body.vendor_id,
      credit_date: body.credit_date,
      reason: body.reason ?? null,
      memo: body.memo ?? null,
      purchase_order_id: body.purchase_order_id ?? null,
      vendor_bill_id: body.vendor_bill_id ?? null,
      lines: body.lines,
      actor_id: actorId,
    });
    return res.status(201).json({ vendor_credit: created });
  } catch (error) {
    return creditError(res, error);
  } finally {
    client.release();
  }
}
