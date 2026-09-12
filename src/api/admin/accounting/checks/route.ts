import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import {
  createBankCheck,
  getBankCheck,
  listBankChecks,
  postBankCheck,
} from "../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
  parseListFilters,
} from "../../../../lib/ledger/documents/manual-http";
import {
  bankCheckBodySchema,
  toBankCheckInput,
} from "../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../lib/pos/access-level";
import { getDbPool } from "../../../utils/db-pool";

/**
 * /admin/accounting/checks — Checks / Expenses / Card charges (un solo documento, `kind` derivado).
 *
 * GET  ?from&to&status&account_list_id&q&limit&cursor   (account_list_id matchea banco O línea)
 *   → { items: Check[], next_cursor: "<day>,<id>" | null }
 * POST { day, bank_account_list_id, number?, payee_type: "vendor"|"customer"|"other", payee_id?,
 *        payee_name, memo?, to_be_printed?, evidence_id?, post?: boolean,
 *        lines: [{ account_list_id, amount_cents (≠0), memo?, customer_id?, billable? }] }
 *   → 201 { check: Check, post?: { status: "posted"|"already_posted", entry_id } }
 *
 * Check = { id, number (nº de cheque, libre) | null, doc_number "CHK-0001",
 *   kind: "check"|"expense"|"card_charge"  (CreditCard → card_charge; sino number ? check : expense),
 *   day, bank_account_list_id, bank_account_snapshot {id,name,account_type},
 *   payee_type, payee_id, payee_name, memo, total_cents (Σ líneas), status draft|posted|voided,
 *   entry_id, posted_at, voided_at, void_reason, to_be_printed, evidence_id,
 *   created_by, created_at, updated_at,
 *   lines: [{ id, sort_order, account_list_id, account_snapshot, amount_cents, memo, customer_id, billable }] }
 * Asiento: Dr cada línea / Cr banco (o tarjeta) por el total.
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
    return res.json(
      await listBankChecks(
        client,
        parseListFilters(req.query as Record<string, unknown>)
      )
    );
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = bankCheckBodySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    const created = await createBankCheck(
      client,
      toBankCheckInput(parsed.data),
      actorId
    );
    if (!parsed.data.post) return res.status(201).json({ check: created });
    const post = await postBankCheck(client, created.id, actorId);
    return res
      .status(201)
      .json({ check: await getBankCheck(client, created.id), post });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
