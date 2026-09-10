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

interface EntryRow {
  id: string;
  day: string;
  kind: string;
  amount_cents: string;
  currency: string;
  reference: string;
  description: string;
  source_kind: string | null;
  source_id: string | null;
  document_number: string | null;
  posted_by: string | null;
  actor_id: string;
  reverses_entry_id: string | null;
  reason: string | null;
  created_at: string;
  reversed_by: string | null;
}

interface LineRow {
  entry_id: string;
  role: string;
  account_list_id: string;
  account_snapshot: Record<string, unknown>;
  debit_cents: string;
  credit_cents: string;
}

/**
 * Journal entries with lines, over `[from, to]`, optionally filtered by
 * account / source. Keyset pagination on (day, id) ascending — `cursor` is
 * `"<day>,<id>"` of the last row of the previous page.
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

  const accountListId =
    typeof req.query.account_list_id === "string" &&
    req.query.account_list_id.trim()
      ? req.query.account_list_id.trim()
      : null;
  const sourceKind =
    typeof req.query.source_kind === "string" && req.query.source_kind.trim()
      ? req.query.source_kind.trim()
      : null;
  const sourceId =
    typeof req.query.source_id === "string" && req.query.source_id.trim()
      ? req.query.source_id.trim()
      : null;

  const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(200, Math.max(1, rawLimit))
    : 50;

  let cursorDay: string | null = null;
  let cursorId: string | null = null;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
  if (cursor) {
    const [day, id] = cursor.split(",");
    if (!DAY_RE.test(day ?? "") || !id) {
      return res.status(400).json({
        error: "cursor must be '<day>,<id>' from a previous page",
        code: "invalid_cursor",
      });
    }
    cursorDay = day ?? null;
    cursorId = id ?? null;
  }

  const db = dbFrom(req);

  const where: string[] = ["e.deleted_at IS NULL", "e.day >= ?", "e.day <= ?"];
  const bindings: unknown[] = [from, to];

  if (cursorDay && cursorId) {
    where.push("(e.day, e.id) > (?, ?)");
    bindings.push(cursorDay, cursorId);
  }
  if (sourceKind) {
    where.push("e.source_kind = ?");
    bindings.push(sourceKind);
  }
  if (sourceId) {
    where.push("e.source_id = ?");
    bindings.push(sourceId);
  }
  if (accountListId) {
    where.push(
      "EXISTS (SELECT 1 FROM bank_journal_line l WHERE l.entry_id = e.id AND l.account_list_id = ? AND l.deleted_at IS NULL)"
    );
    bindings.push(accountListId);
  }

  const whereSql = where.join(" AND ");

  const entriesResult = await db.raw(
    `SELECT e.id, e.day, e.kind, e.amount_cents::text AS amount_cents, e.currency,
            e.reference, e.description, e.source_kind, e.source_id,
            e.document_number, e.posted_by, e.actor_id, e.reverses_entry_id,
            e.reason, e.created_at,
            (SELECT r.id FROM bank_journal_entry r
              WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL
              LIMIT 1) AS reversed_by
       FROM bank_journal_entry e
      WHERE ${whereSql}
      ORDER BY e.day ASC, e.id ASC
      LIMIT ?`,
    [...bindings, limit]
  );

  const entries = entriesResult.rows as unknown as EntryRow[];
  const entryIds = entries.map((e) => e.id);

  let lines: LineRow[] = [];
  if (entryIds.length > 0) {
    const placeholders = entryIds.map(() => "?").join(",");
    const linesResult = await db.raw(
      `SELECT l.entry_id, l.role, l.account_list_id, l.account_snapshot,
              l.debit_cents::text AS debit_cents, l.credit_cents::text AS credit_cents
         FROM bank_journal_line l
        WHERE l.entry_id IN (${placeholders}) AND l.deleted_at IS NULL
        ORDER BY l.entry_id, l.role`,
      entryIds
    );
    lines = linesResult.rows as unknown as LineRow[];
  }

  const linesByEntry = new Map<string, LineRow[]>();
  for (const line of lines) {
    const bucket = linesByEntry.get(line.entry_id) ?? [];
    bucket.push(line);
    linesByEntry.set(line.entry_id, bucket);
  }

  const items = entries.map((entry) => ({
    id: entry.id,
    day: entry.day,
    kind: entry.kind,
    amount_cents: entry.amount_cents,
    currency: entry.currency,
    reference: entry.reference,
    description: entry.description,
    source_kind: entry.source_kind,
    source_id: entry.source_id,
    document_number: entry.document_number,
    posted_by: entry.posted_by,
    actor_id: entry.actor_id,
    reverses_entry_id: entry.reverses_entry_id,
    reversed_by: entry.reversed_by,
    reason: entry.reason,
    created_at: entry.created_at,
    lines: (linesByEntry.get(entry.id) ?? []).map((line) => ({
      role: line.role,
      account_list_id: line.account_list_id,
      account_snapshot: line.account_snapshot,
      debit_cents: line.debit_cents,
      credit_cents: line.credit_cents,
    })),
  }));

  const last = entries[entries.length - 1];
  const nextCursor =
    entries.length === limit && last ? `${last.day},${last.id}` : null;

  return res.json({ entries: items, next_cursor: nextCursor });
}
