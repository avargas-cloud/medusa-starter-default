import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import {
  createBankTransfer,
  getBankTransfer,
  listBankTransfers,
  postBankTransfer,
} from "../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
  parseListFilters,
} from "../../../../lib/ledger/documents/manual-http";
import {
  bankTransferBodySchema,
  toBankTransferInput,
} from "../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../lib/pos/access-level";
import { getDbPool } from "../../../utils/db-pool";

/**
 * /admin/accounting/transfers — transferencias entre cuentas de balance.
 *
 * GET  ?from&to&status&account_list_id&q&limit&cursor   (account_list_id matchea from O to)
 *   → { items: Transfer[], next_cursor: "<day>,<id>" | null }
 * POST { day, from_account_list_id, to_account_list_id, amount_cents (>0), memo?, evidence_id?, post?: boolean }
 *   → 201 { transfer: Transfer, post?: { status: "posted"|"already_posted", entry_id } }
 *
 * Transfer = { id, doc_number "TR-0001", day, from_account_list_id, from_snapshot {id,name,account_type},
 *   to_account_list_id, to_snapshot, amount_cents, memo, status draft|posted|voided, entry_id,
 *   posted_at, voided_at, void_reason, evidence_id, created_by, created_at, updated_at }
 * Asiento: Dr to_account / Cr from_account. Tipos admitidos: Bank, CreditCard, OtherCurrentAsset,
 * OtherCurrentLiability, LongTermLiability, Equity. No hay PATCH: anular y crear de nuevo.
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
      await listBankTransfers(
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
  const parsed = bankTransferBodySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    const created = await createBankTransfer(
      client,
      toBankTransferInput(parsed.data),
      actorId
    );
    if (!parsed.data.post) return res.status(201).json({ transfer: created });
    const post = await postBankTransfer(client, created.id, actorId);
    return res
      .status(201)
      .json({ transfer: await getBankTransfer(client, created.id), post });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
