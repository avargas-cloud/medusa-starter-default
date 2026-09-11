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

/** GET: list vendor credits, filterable by vendor_id/status. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { vendor_id, status, limit, offset } = req.query as Record<string, string | undefined>;
  const clauses: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  if (vendor_id) {
    params.push(vendor_id);
    clauses.push(`vendor_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;
  params.push(lim, off);

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, number, vendor_id, vendor_name_snapshot, credit_date, status, total_cents, applied_cents,
            qb_txn_id, posted_at, voided_at, created_at
       FROM vendor_credit
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ vendor_credits: rows });
}

/**
 * POST { vendor_id, credit_date, reason?, memo?, lines? }: creates a draft.
 * `lines` may be omitted or `[]` — the POS creates the header first and
 * edits lines afterward with PATCH; `post` is where ≥1 line is enforced.
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
    lines?: VendorCreditLineInput[];
  };
  if (
    !body.vendor_id ||
    !body.credit_date ||
    (body.lines !== undefined && !Array.isArray(body.lines))
  ) {
    return res.status(400).json({
      error: "vendor_id and credit_date are required; lines, if present, must be an array.",
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
      lines: body.lines ?? [],
      actor_id: actorId,
    });
    return res.status(201).json({ vendor_credit: created });
  } catch (error) {
    return creditError(res, error);
  } finally {
    client.release();
  }
}
