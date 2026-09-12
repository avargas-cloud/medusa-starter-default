import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import type { SqlClient } from "../../../../../lib/accounting/month-close-data";
import {
  activeEntryPredicate,
  docLabelFor,
  GL_CHECK_PAYEE_COLUMNS,
  glCheckJoinSql,
  normalBalanceFor,
  PAYEE_JOIN_SQL,
  payeeColumnSql,
} from "../../../../../lib/ledger/reports";
import {
  DAY_RE,
  dbFrom,
  invalidRange,
  isDay,
  queryString,
  requireAccountingOr403,
} from "../../../../../lib/ledger/reports/route-common";

interface AccountRow {
  list_id: string;
  name: string;
  full_name: string;
  account_type: string;
  normal_balance: string | null;
}

interface RegisterRow {
  entry_id: string;
  line_id: string;
  day: string;
  source_kind: string | null;
  source_id: string | null;
  document_number: string | null;
  memo: string;
  payee_name: string | null;
  debit_cents: string;
  credit_cents: string;
  balance_cents: string;
  reversed: boolean;
  statement_id: string | null;
}

interface TotalsRow {
  debit_cents: string;
  credit_cents: string;
  opening_cents: string;
  closing_cents: string;
}

/**
 * E1's `gl_check` may not exist yet (or may exist without a name column):
 * detect both at query time so the register degrades to `payee_name: null`
 * for checks instead of failing the whole page.
 */
async function glCheckPayeeColumn(db: SqlClient): Promise<string | null> {
  const result = await db.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'gl_check'
        AND to_regclass('public.gl_check') IS NOT NULL
        AND column_name = ANY(?::text[])`,
    [[...GL_CHECK_PAYEE_COLUMNS]]
  );
  const present = new Set(
    (result.rows as Array<{ column_name: string }>).map((r) => r.column_name)
  );
  return GL_CHECK_PAYEE_COLUMNS.find((c) => present.has(c)) ?? null;
}

/**
 * Account register: every journal line of ONE account over `[from, to]` with
 * a server-side running balance. The balance is a window SUM over the full
 * ordered set (day, entry_id, line_id) BEFORE the cleared/q filters and the
 * keyset cursor apply, so a filtered or paged view still shows the true
 * balance at each row. Reversed pairs never move the balance; they are only
 * listed (flagged `reversed: true`) when `?include_reversed=true`. Amounts are
 * strings (bigint-safe); opening/balance/closing are signed by the account's
 * normal side (positive = normal side), like the chart of accounts.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await requireAccountingOr403(req, res))) return;

  const accountListId = queryString(req, "account_list_id");
  if (!accountListId) {
    return res
      .status(400)
      .json({ error: "account_list_id is required", code: "invalid_account" });
  }
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  if (!isDay(from) || !isDay(to) || from > to) return invalidRange(res);

  const cleared = queryString(req, "cleared") ?? "all";
  if (!["all", "cleared", "uncleared"].includes(cleared)) {
    return res.status(400).json({
      error: "cleared must be all | cleared | uncleared",
      code: "invalid_cleared",
    });
  }
  const q = queryString(req, "q");
  const includeReversed = queryString(req, "include_reversed") === "true";
  const rawLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(500, Math.max(1, rawLimit))
    : 100;

  let cursor: { day: string; entryId: string; lineId: string } | null = null;
  const cursorRaw = queryString(req, "cursor");
  if (cursorRaw) {
    const [day, entryId, lineId] = cursorRaw.split(",");
    if (!day || !DAY_RE.test(day) || !entryId || !lineId) {
      return res.status(400).json({
        error:
          "cursor must be '<day>,<entry_id>,<line_id>' from a previous page",
        code: "invalid_cursor",
      });
    }
    cursor = { day, entryId, lineId };
  }

  const db = dbFrom(req);
  const accountResult = await db.raw(
    `SELECT qb_list_id AS list_id, name, full_name, account_type, normal_balance
       FROM qb_account WHERE qb_list_id = ? AND deleted_at IS NULL`,
    [accountListId]
  );
  const account = (accountResult.rows as unknown as AccountRow[])[0];
  if (!account) {
    return res
      .status(404)
      .json({ error: "account not found", code: "account_not_found" });
  }
  const normalSide =
    account.normal_balance ?? normalBalanceFor(account.account_type);
  const sign = normalSide === "debit" ? 1 : -1;

  const payeeColumn = await glCheckPayeeColumn(db);
  const payeeSql = payeeColumnSql(payeeColumn);
  const joins = PAYEE_JOIN_SQL + glCheckJoinSql(payeeColumn);

  const base = `
    WITH acct_lines AS (
      SELECT l.id AS line_id, l.entry_id, e.day, e.source_kind, e.source_id,
             e.document_number, e.description, e.reference,
             l.debit_cents, l.credit_cents,
             NOT (${activeEntryPredicate("e")}) AS reversed
        FROM bank_journal_line l
        JOIN bank_journal_entry e ON e.id = l.entry_id
       WHERE l.deleted_at IS NULL AND e.deleted_at IS NULL AND l.account_list_id = ?
    ),
    opening AS (
      SELECT COALESCE(SUM(debit_cents - credit_cents), 0) AS cents
        FROM acct_lines WHERE NOT reversed AND day < ?
    ),
    ranged AS (
      SELECT a.*,
             (SELECT cents FROM opening)
               + SUM(CASE WHEN a.reversed THEN 0 ELSE a.debit_cents - a.credit_cents END)
                 OVER (ORDER BY a.day, a.entry_id, a.line_id ROWS UNBOUNDED PRECEDING) AS raw_balance
        FROM acct_lines a
       WHERE a.day >= ? AND a.day <= ?
    ),
    detailed AS (
      SELECT r.*, ${payeeSql} AS payee_name,
             (SELECT m.statement_id FROM bank_statement_match m
               WHERE m.book_kind = 'journal_line' AND m.book_id = r.line_id
                 AND m.deleted_at IS NULL
               ORDER BY m.created_at DESC LIMIT 1) AS statement_id
        FROM ranged r
        JOIN bank_journal_entry e ON e.id = r.entry_id
        ${joins}
    )`;

  const filters: string[] = [];
  const filterBindings: unknown[] = [];
  if (!includeReversed) filters.push("NOT d.reversed");
  if (cleared === "cleared") filters.push("d.statement_id IS NOT NULL");
  if (cleared === "uncleared") filters.push("d.statement_id IS NULL");
  if (q) {
    filters.push(
      "(d.description ILIKE ? OR d.reference ILIKE ? OR COALESCE(d.document_number, '') ILIKE ? OR COALESCE(d.payee_name, '') ILIKE ?)"
    );
    const like = `%${q}%`;
    filterBindings.push(like, like, like, like);
  }
  const filterSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const baseBindings = [accountListId, from, from, to];

  const pageWhere = [
    ...filters,
    ...(cursor ? ["(d.day, d.entry_id, d.line_id) > (?, ?, ?)"] : []),
  ];
  const pageResult = await db.raw(
    `${base}
     SELECT d.entry_id, d.line_id, d.day, d.source_kind, d.source_id, d.document_number,
            d.description AS memo, d.payee_name,
            d.debit_cents::text AS debit_cents, d.credit_cents::text AS credit_cents,
            (? * d.raw_balance)::text AS balance_cents, d.reversed, d.statement_id
       FROM detailed d
       ${pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : ""}
      ORDER BY d.day, d.entry_id, d.line_id
      LIMIT ?`,
    [
      ...baseBindings,
      sign,
      ...filterBindings,
      ...(cursor ? [cursor.day, cursor.entryId, cursor.lineId] : []),
      limit,
    ]
  );
  const rows = pageResult.rows as unknown as RegisterRow[];

  const totalsResult = await db.raw(
    `${base}
     SELECT COALESCE((SELECT SUM(d.debit_cents) FROM detailed d ${filterSql}), 0)::text AS debit_cents,
            COALESCE((SELECT SUM(d.credit_cents) FROM detailed d ${filterSql}), 0)::text AS credit_cents,
            (? * (SELECT cents FROM opening))::text AS opening_cents,
            (? * ((SELECT cents FROM opening)
               + COALESCE((SELECT SUM(r.debit_cents - r.credit_cents) FROM ranged r WHERE NOT r.reversed), 0)))::text AS closing_cents`,
    [...baseBindings, ...filterBindings, ...filterBindings, sign, sign]
  );
  const totals: TotalsRow = (
    totalsResult.rows as unknown as TotalsRow[]
  )[0] ?? {
    debit_cents: "0",
    credit_cents: "0",
    opening_cents: "0",
    closing_cents: "0",
  };

  const last = rows[rows.length - 1];
  return res.json({
    account: {
      list_id: account.list_id,
      name: account.name,
      full_name: account.full_name,
      account_type: account.account_type,
      normal_balance: normalSide,
    },
    opening_cents: totals.opening_cents,
    rows: rows.map((r) => ({
      entry_id: r.entry_id,
      line_id: r.line_id,
      day: r.day,
      source_kind: r.source_kind,
      document_number: r.document_number,
      doc_label: docLabelFor(r.source_kind, r.document_number),
      payee_name: r.payee_name,
      memo: r.memo,
      debit_cents: r.debit_cents,
      credit_cents: r.credit_cents,
      balance_cents: r.balance_cents,
      cleared: r.statement_id !== null,
      statement_id: r.statement_id,
      reversed: r.reversed,
      document_ref:
        r.source_kind && r.source_id
          ? { kind: r.source_kind, id: r.source_id }
          : null,
    })),
    closing_cents: totals.closing_cents,
    totals: {
      debit_cents: totals.debit_cents,
      credit_cents: totals.credit_cents,
    },
    next_cursor:
      rows.length === limit && last
        ? `${last.day},${last.entry_id},${last.line_id}`
        : null,
  });
}
