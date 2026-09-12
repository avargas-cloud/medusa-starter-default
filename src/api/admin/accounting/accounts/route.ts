import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  ACCOUNT_TYPE_ORDER,
  activeEntryPredicate,
  buildHierarchy,
  normalBalanceFor,
  normalizeSign,
} from "../../../../lib/ledger/reports";
import {
  AccountWriteError,
  createAccount,
  validateName,
} from "../../../../lib/ledger/reports/accounts-write";
import {
  dbFrom,
  queryString,
  requireAccountingOr403,
} from "../../../../lib/ledger/reports/route-common";
import { accessFailure, assertOwner } from "../../../../lib/pos/access-level";
import { getDbPool } from "../../../utils/db-pool";

interface AccountRow {
  list_id: string;
  name: string;
  full_name: string;
  account_type: string;
  normal_balance: string | null;
  account_number: string | null;
  parent_list_id: string | null;
  parent_full_name: string | null;
  is_active: boolean;
  description: string | null;
  raw_cents: string;
}

/**
 * Chart of accounts (the `qb_account` mirror) with the CURRENT journal
 * balance of each account, signed by its normal side. Active only unless
 * `?include_inactive=true`; `?q=` matches name / full_name / account_number.
 * Read = accounting; POST/PATCH = owner.
 *
 * `balance_cents` = `balance_own_cents` = postings on the account itself (what
 * its register closes at). `balance_rollup_cents` = own + every descendant —
 * the figure the Balance Sheet prints on a parent row (audit P1-3: the chart
 * said `Loan Receivable $0.00` while the statement said `($2,064.85)`). The
 * roll-up is computed over the WHOLE chart before the active/q filters, so a
 * parent keeps its subtotal when its children are hidden.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await requireAccountingOr403(req, res))) return;

  const includeInactive = queryString(req, "include_inactive") === "true";
  const q = queryString(req, "q");
  const where = ["qa.deleted_at IS NULL", "qa.account_type <> 'NonPosting'"];
  const bindings: unknown[] = [];

  const result = await dbFrom(req).raw(
    `WITH balance AS (
       SELECT l.account_list_id, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS raw_cents
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")}
        GROUP BY l.account_list_id
     )
     SELECT qa.qb_list_id AS list_id, qa.name, qa.full_name, qa.account_type,
            qa.normal_balance, qa.account_number, qa.parent_list_id, qa.parent_full_name,
            qa.is_active, qa.metadata->>'description' AS description,
            COALESCE(b.raw_cents, 0)::text AS raw_cents
       FROM qb_account qa
       LEFT JOIN balance b ON b.account_list_id = qa.qb_list_id
      WHERE ${where.join(" AND ")}
      ORDER BY array_position(ARRAY[${ACCOUNT_TYPE_ORDER.map(() => "?").join(",")}]::text[], qa.account_type) NULLS LAST,
               qa.account_number NULLS LAST, qa.full_name`,
    [...bindings, ...ACCOUNT_TYPE_ORDER]
  );
  const allRows = result.rows as unknown as AccountRow[];
  const byFullName = new Map(allRows.map((r) => [r.full_name, r.list_id]));
  // Roll-up over the whole chart (raw Σdebit − Σcredit; signed per row below).
  const rollup = new Map(
    buildHierarchy(
      allRows.map((r) => ({
        list_id: r.list_id,
        name: r.name,
        full_name: r.full_name,
        account_number: r.account_number,
        parent_list_id: r.parent_list_id,
        parent_full_name: r.parent_full_name,
        cents: BigInt(r.raw_cents),
        compare_cents: null,
      }))
    ).map((h) => [h.list_id, h])
  );

  const needle = q?.toLowerCase() ?? null;
  const rows = allRows.filter(
    (r) =>
      (includeInactive || r.is_active) &&
      (!needle ||
        r.full_name.toLowerCase().includes(needle) ||
        (r.account_number ?? "").toLowerCase().includes(needle))
  );

  return res.json({
    items: rows.map((r) => {
      const normal = r.normal_balance ?? normalBalanceFor(r.account_type);
      const own = normalizeSign(BigInt(r.raw_cents), r.account_type);
      const tree = rollup.get(r.list_id);
      const rolled = tree ? normalizeSign(tree.cents, r.account_type) : own;
      return {
        list_id: r.list_id,
        name: r.name,
        full_name: r.full_name,
        account_type: r.account_type,
        normal_balance: normal,
        account_number: r.account_number,
        parent_list_id:
          r.parent_list_id ??
          (r.parent_full_name
            ? (byFullName.get(r.parent_full_name) ?? null)
            : null),
        is_active: r.is_active,
        is_pos_owned: r.list_id.startsWith("pos_"),
        description: r.description,
        balance_cents: own.toString(),
        balance_own_cents: own.toString(),
        balance_rollup_cents: rolled.toString(),
        has_children: tree?.has_children ?? false,
      };
    }),
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  const client = await getDbPool().connect();
  try {
    const name = validateName(body.name);
    const accountType =
      typeof body.account_type === "string" ? body.account_type.trim() : "";
    await client.query("BEGIN");
    const listId = await createAccount(client, {
      name,
      account_type: accountType,
      parent_list_id:
        typeof body.parent_list_id === "string" && body.parent_list_id.trim()
          ? body.parent_list_id.trim()
          : null,
      account_number:
        typeof body.account_number === "string" && body.account_number.trim()
          ? body.account_number.trim()
          : null,
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : null,
    });
    await client.query("COMMIT");
    return res.status(201).json({ list_id: listId });
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
