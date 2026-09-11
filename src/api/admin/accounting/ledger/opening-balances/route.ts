import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import {
  LedgerError,
  listOpeningBalances,
  postOpeningBalance,
  type OpeningBalanceItem,
} from "../../../../../lib/ledger";
import { getDbPool } from "../../../../utils/db-pool";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  throw error;
}

/** Status HTTP por `LedgerErrorCode` — la config faltante y el duplicado son
 * conflictos del estado del GL, no errores del cliente; el resto es 400. */
function ledgerErrorStatus(code: LedgerError["code"]): number {
  if (
    code === "GL_ALREADY_POSTED" ||
    code === "GL_ACCOUNT_MAP_MISSING" ||
    code === "GL_PERIOD_CLOSED"
  )
    return 409;
  if (code === "GL_UNBALANCED_DOCUMENT") return 500;
  return 400;
}

function ledgerError(res: MedusaResponse, error: unknown) {
  if (error instanceof LedgerError) {
    return res
      .status(ledgerErrorStatus(error.code))
      .json({ error: error.message, code: error.code, details: error.details });
  }
  throw error;
}

const itemSchema = z
  .object({
    key: z.string().trim().min(1).max(200),
    kind: z.enum(["outstanding_check", "deposit_in_transit"]),
    original_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount_cents: z.number().int().positive(),
    reference: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    account_list_id: z.string().trim().min(1),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    balance_cents: z.number().int().min(0).max(999999999999),
    evidence_ids: z.array(z.string().trim().min(1)).min(1),
    items: z.array(itemSchema).max(200).default([]),
  })
  .strict();

/**
 * GET /admin/accounting/ledger/opening-balances
 *
 * Toda cuenta de balance elegible con su OBE activo (o `null`), y si
 * `opening_balance_equity` resuelve — Banking-on-GL §2/§6.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await listOpeningBalances(client);
    return res.json(result);
  } finally {
    client.release();
  }
}

/**
 * POST /admin/accounting/ledger/opening-balances
 *
 * Postea el OBE de una cuenta: `{ account_list_id, day?, balance_cents,
 * evidence_ids, items? }`. Idempotente por `(source_kind, source_id)` — una
 * segunda llamada devuelve 409 `GL_ALREADY_POSTED` en vez de reintentar.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
      code: "invalid_body",
    });
  }
  const body = parsed.data;

  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await postOpeningBalance(client, {
      account_list_id: body.account_list_id,
      day: body.day,
      balance_cents: BigInt(body.balance_cents),
      evidence_ids: body.evidence_ids,
      items: body.items.map(
        (item): OpeningBalanceItem => ({
          ...item,
          amount_cents: BigInt(item.amount_cents),
        })
      ),
      actor_id: actorId,
    });

    if (result.status === "already_posted") {
      return res.status(409).json({
        error: "Opening balance already posted for this account",
        code: "GL_ALREADY_POSTED",
        entry_id: result.entry_id,
      });
    }
    return res.status(201).json(result);
  } catch (error) {
    return ledgerError(res, error);
  } finally {
    client.release();
  }
}
