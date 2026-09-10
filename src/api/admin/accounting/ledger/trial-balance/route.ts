import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import type { SqlClient } from "../../../../../lib/accounting/month-close-data";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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

interface TrialBalanceRow {
  list_id: string;
  full_name: string | null;
  account_type: string | null;
  normal_balance: "debit" | "credit" | null;
  opening_cents: string;
  debit_cents: string;
  credit_cents: string;
  closing_cents: string;
}

/**
 * Every active journal line (legacy + completion + document families) rolled
 * up per account, over the requested `[from, to]` window. "Active" = no other
 * entry reverses it (a reversal entry counts its own lines — nothing reverses
 * a reversal). Amounts travel as strings (bigint-safe); the caller sums with
 * BigInt, never Number.
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

  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    return res.status(400).json({
      error: "from and to are required in YYYY-MM-DD format, with from <= to",
      code: "invalid_range",
    });
  }

  const db = dbFrom(req);
  const result = await db.raw(
    `WITH active_entries AS (
       SELECT e.id, e.day
       FROM bank_journal_entry e
       WHERE e.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM bank_journal_entry r
           WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL
         )
     ),
     opening AS (
       SELECT l.account_list_id,
              COALESCE(SUM(l.debit_cents), 0) - COALESCE(SUM(l.credit_cents), 0) AS opening_cents
       FROM bank_journal_line l
       JOIN active_entries e ON e.id = l.entry_id
       WHERE l.deleted_at IS NULL AND e.day < ?
       GROUP BY l.account_list_id
     ),
     period AS (
       SELECT l.account_list_id,
              COALESCE(SUM(l.debit_cents), 0) AS debit_cents,
              COALESCE(SUM(l.credit_cents), 0) AS credit_cents
       FROM bank_journal_line l
       JOIN active_entries e ON e.id = l.entry_id
       WHERE l.deleted_at IS NULL AND e.day >= ? AND e.day <= ?
       GROUP BY l.account_list_id
     ),
     accounts AS (
       SELECT COALESCE(o.account_list_id, p.account_list_id) AS account_list_id,
              COALESCE(o.opening_cents, 0) AS opening_cents,
              COALESCE(p.debit_cents, 0) AS debit_cents,
              COALESCE(p.credit_cents, 0) AS credit_cents
       FROM opening o
       FULL OUTER JOIN period p ON p.account_list_id = o.account_list_id
     )
     SELECT a.account_list_id AS list_id,
            qa.full_name AS full_name,
            qa.account_type AS account_type,
            qa.normal_balance AS normal_balance,
            a.opening_cents::text AS opening_cents,
            a.debit_cents::text AS debit_cents,
            a.credit_cents::text AS credit_cents,
            (a.opening_cents + a.debit_cents - a.credit_cents)::text AS closing_cents
     FROM accounts a
     LEFT JOIN qb_account qa
       ON qa.qb_list_id = a.account_list_id AND qa.deleted_at IS NULL
     ORDER BY qa.full_name NULLS LAST, a.account_list_id`,
    [from, from, to]
  );

  const rows = result.rows as unknown as TrialBalanceRow[];

  let openingTotal = 0n;
  let debitTotal = 0n;
  let creditTotal = 0n;
  let closingTotal = 0n;
  for (const row of rows) {
    openingTotal += BigInt(row.opening_cents);
    debitTotal += BigInt(row.debit_cents);
    creditTotal += BigInt(row.credit_cents);
    closingTotal += BigInt(row.closing_cents);
  }

  const balanced = debitTotal === creditTotal && closingTotal === 0n;

  return res.json({
    accounts: rows.map((row) => ({
      list_id: row.list_id,
      full_name: row.full_name,
      account_type: row.account_type,
      normal_balance: row.normal_balance,
      opening_cents: row.opening_cents,
      debit_cents: row.debit_cents,
      credit_cents: row.credit_cents,
      closing_cents: row.closing_cents,
    })),
    totals: {
      opening_cents: openingTotal.toString(),
      debit_cents: debitTotal.toString(),
      credit_cents: creditTotal.toString(),
      closing_cents: closingTotal.toString(),
    },
    balanced,
  });
}
