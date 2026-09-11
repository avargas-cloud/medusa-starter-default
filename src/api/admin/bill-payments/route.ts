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
  createBillPayment,
  BillPaymentError,
  type BillPaymentAllocationInput,
  type BillPaymentMethod,
} from "../../../lib/bill-payments";
import type { SqlClient } from "../../../lib/accounting/month-close-data";
import { bankingErrorResponse } from "../../../lib/accounting/banking-error-http";
import { runLedgerHook } from "../../../lib/ledger-hooks/run-ledger-hook";
import { postBillPayment } from "../../../lib/ledger";
import { enqueueBillPaymentAdd } from "../../../lib/purchase-orders/qb-bill-payment-enqueue";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

/** GET: list bill payments, filterable by vendor_id/status. */
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
    `SELECT id, number, vendor_id, vendor_name_snapshot, bank_account_list_id,
            bank_account_snapshot->>'name' AS bank_account_name, payment_date, method,
            reference, amount_cents, status, qb_txn_id, posted_at, voided_at
       FROM vendor_bill_payment
      WHERE ${clauses.join(" AND ")}
      ORDER BY posted_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ bill_payments: rows });
}

/** POST { vendor_id, bank_account_list_id, payment_date, method, reference?, memo?, allocations[] }. */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const body = req.body as {
    vendor_id?: string;
    bank_account_list_id?: string;
    payment_date?: string;
    method?: BillPaymentMethod;
    reference?: string | null;
    memo?: string | null;
    allocations?: BillPaymentAllocationInput[];
  };
  if (
    !body.vendor_id ||
    !body.bank_account_list_id ||
    !body.payment_date ||
    !body.method ||
    !Array.isArray(body.allocations) ||
    body.allocations.length === 0
  ) {
    return res.status(400).json({
      error: "vendor_id, bank_account_list_id, payment_date, method and allocations are required.",
      code: "invalid_body",
    });
  }

  let created: { id: string; number: string };
  const client = await getDbPool().connect();
  try {
    created = await createBillPayment(client, {
      vendor_id: body.vendor_id,
      bank_account_list_id: body.bank_account_list_id,
      payment_date: body.payment_date,
      method: body.method,
      reference: body.reference ?? null,
      memo: body.memo ?? null,
      allocations: body.allocations,
      actor_id: actorId,
    });
  } catch (error) {
    if (error instanceof BillPaymentError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  } finally {
    client.release();
  }

  await runLedgerHook((c) => postBillPayment(c, created.id, actorId), {
    source_kind: "vendor_bill_payment",
    source_id: created.id,
  });

  const knex = req.scope.resolve("__pg_connection__") as SqlClient;
  const qbResult = await enqueueBillPaymentAdd(knex, created.id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return res.status(201).json({ bill_payment: created, qb: qbResult });
}
