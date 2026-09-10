import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { accessFailure, assertOwner } from "../../../../../lib/pos/access-level";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import type { SqlClient } from "../../../../../lib/accounting/month-close-data";
import {
  LEDGER_ACCOUNT_MAP_KEYS,
  LEDGER_ACCOUNT_MAP_KEY_SET,
} from "../../../../../lib/accounting/ledger-account-map-keys";

function dbFrom(req: AuthenticatedMedusaRequest): SqlClient {
  return req.scope.resolve("__pg_connection__") as SqlClient;
}

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  throw error;
}

interface MapRow {
  key: string;
  qb_list_id: string;
}

interface AccountRow {
  qb_list_id: string;
  full_name: string;
  account_type: string;
}

/**
 * GET: the 9 keys of `gl_account_map` (`ledger-account-map-keys.ts`), each
 * resolved (if a row exists and its account is still active) or null, plus
 * the active `qb_account` candidates whose type matches `allowed_types`.
 * Read access = accounting (same as Month Close); writing a mapping is
 * owner-only, enforced below in POST.
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

  const db = dbFrom(req);
  const [mapResult, accountsResult] = await Promise.all([
    db.raw(`SELECT key, qb_list_id FROM gl_account_map`),
    db.raw(
      `SELECT qb_list_id, full_name, account_type
         FROM qb_account
        WHERE deleted_at IS NULL AND is_active = true
        ORDER BY full_name`
    ),
  ]);

  const mapByKey = new Map<string, string>();
  for (const row of mapResult.rows as unknown as MapRow[]) {
    mapByKey.set(row.key, row.qb_list_id);
  }
  const accounts = accountsResult.rows as unknown as AccountRow[];
  const accountsByListId = new Map(accounts.map((a) => [a.qb_list_id, a]));

  const keys = LEDGER_ACCOUNT_MAP_KEYS.map((def) => {
    const qbListId = mapByKey.get(def.key) ?? null;
    const resolvedAccount = qbListId ? accountsByListId.get(qbListId) : null;
    const candidates = accounts
      .filter((a) => def.allowedTypes.includes(a.account_type))
      .map((a) => ({ qb_list_id: a.qb_list_id, full_name: a.full_name }));
    return {
      key: def.key,
      label: def.label,
      allowed_types: def.allowedTypes,
      resolved: resolvedAccount
        ? {
            qb_list_id: resolvedAccount.qb_list_id,
            full_name: resolvedAccount.full_name,
            account_type: resolvedAccount.account_type,
          }
        : null,
      candidates,
    };
  });

  return res.json({ keys });
}

/**
 * POST { key, qb_list_id }: owner-only. Validates key ∈ the fixed list and
 * the target account's type ∈ allowed_types and is_active, then upserts with
 * a fresh `account_snapshot`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertOwner(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }

  const body = req.body as { key?: string; qb_list_id?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const qbListId =
    typeof body.qb_list_id === "string" ? body.qb_list_id.trim() : "";

  if (!LEDGER_ACCOUNT_MAP_KEY_SET.has(key)) {
    return res.status(400).json({
      error: `Unknown ledger account map key: ${key}`,
      code: "invalid_key",
    });
  }
  if (!qbListId) {
    return res.status(400).json({
      error: "qb_list_id is required",
      code: "invalid_qb_list_id",
    });
  }

  const def = LEDGER_ACCOUNT_MAP_KEYS.find((entry) => entry.key === key)!;
  const db = dbFrom(req);

  const accountResult = await db.raw(
    `SELECT qb_list_id, full_name, account_type, currency
       FROM qb_account
      WHERE qb_list_id = ? AND deleted_at IS NULL AND is_active = true
      LIMIT 1`,
    [qbListId]
  );
  const account = accountResult.rows[0] as
    | {
        qb_list_id: string;
        full_name: string;
        account_type: string;
        currency: string | null;
      }
    | undefined;

  if (!account) {
    return res.status(404).json({
      error: "Account not found or inactive",
      code: "account_not_found",
    });
  }
  if (!def.allowedTypes.includes(account.account_type)) {
    return res.status(400).json({
      error: `Account type ${account.account_type} is not allowed for ${key}. Allowed: ${def.allowedTypes.join(", ")}`,
      code: "account_type_not_allowed",
    });
  }

  const snapshot = {
    id: account.qb_list_id,
    name: account.full_name,
    account_type: account.account_type,
    currency: "USD",
  };

  const upserted = await db.raw(
    `INSERT INTO gl_account_map (key, qb_list_id, account_snapshot, allowed_types, label, updated_by, created_at, updated_at)
     VALUES (?, ?, ?::jsonb, ?, ?, ?, now(), now())
     ON CONFLICT (key) DO UPDATE SET
       qb_list_id = EXCLUDED.qb_list_id,
       account_snapshot = EXCLUDED.account_snapshot,
       allowed_types = EXCLUDED.allowed_types,
       label = EXCLUDED.label,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING key, qb_list_id, account_snapshot, allowed_types, label, updated_by, updated_at`,
    [
      key,
      qbListId,
      JSON.stringify(snapshot),
      def.allowedTypes,
      def.label,
      actorId,
    ]
  );

  return res.json({ mapping: upserted.rows[0] });
}
