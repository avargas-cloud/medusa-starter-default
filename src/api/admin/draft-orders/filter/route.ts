import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  parseRepSelection,
  repSqlPredicate,
} from "../../../../lib/sales-rep/sql-filter";

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows?: EstimateListDbRow[] }>;
};

type EstimateListDbRow = {
  id: string;
  display_id: number;
  status: string;
  email: string | null;
  currency_code: string;
  total: string | number | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  sales_channel: Record<string, unknown> | null;
};

function parseRange(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Number(value);
  if (Number.isFinite(ms)) {
    return ms > 0 ? new Date(ms).toISOString() : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readQueryString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Exact, compact list projection for the POS Estimates page.
 *
 * The native draft-order endpoint deeply hydrates Medusa relations. Fetching
 * 2,000 records through it took seconds and forced the browser to show a
 * partial recent-200 result first. This SQL route applies the complete active
 * view server-side and returns only fields rendered by the table.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const showNotApproved = req.query.showNotApproved === "true";
  const showCancelled = req.query.showCancelled === "true";
  const query = readQueryString(req.query.q).toLowerCase();
  const queryDigits = query.replace(/\D/g, "");
  const rep = parseRepSelection(req.query as Record<string, unknown>);

  const filters = [
    "o.deleted_at IS NULL",
    "o.is_draft_order = TRUE",
  ];
  const bindings: unknown[] = [];

  if (from) {
    filters.push("o.created_at >= ?::timestamptz");
    bindings.push(from);
  }
  if (to) {
    filters.push("o.created_at <= ?::timestamptz");
    bindings.push(to);
  }
  if (!showNotApproved) {
    filters.push(
      "COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '') NOT IN ('Not Approved', 'not_approved')"
    );
  }
  if (!showCancelled) {
    filters.push(
      "COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '') NOT IN ('Cancelled', 'cancelled', 'Voided', 'voided')"
    );
  }
  // Shared with `../counts` so the rows and the badge labelling them can never
  // drift apart. The helper also drops empty tokens: the predicate this
  // replaced bound `repInitials` unconditionally, so a rep with no initials
  // compared the field against '' and matched every estimate that has no rep.
  const repPredicate = repSqlPredicate(rep, "o");
  if (repPredicate) {
    filters.push(repPredicate.sql);
    bindings.push(...repPredicate.bindings);
  }
  if (query) {
    const searchPredicates = [
      "STRPOS(LOWER(CONCAT_WS(' ', c.first_name, c.last_name)), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.company_name, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.email, o.email, '')), ?) > 0",
      "STRPOS(LOWER('#' || o.display_id::text), ?) > 0",
      "STRPOS(LOWER('e' || o.display_id::text), ?) > 0",
    ];
    bindings.push(query, query, query, query, query);
    if (queryDigits) {
      searchPredicates.push(
        "STRPOS(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), ?) > 0"
      );
      bindings.push(queryDigits);
    }
    filters.push(`(${searchPredicates.join(" OR ")})`);
  }

  const pg = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as SqlClient;

  try {
    const result = await pg.raw(
      `
        SELECT
          o.id,
          o.display_id,
          o.status::text AS status,
          o.email,
          o.currency_code,
          CASE
            WHEN jsonb_typeof(o.metadata->'computed_total') = 'number'
              THEN (o.metadata->>'computed_total')::numeric
            WHEN jsonb_typeof(summary.totals->'current_order_total') = 'number'
              THEN (summary.totals->>'current_order_total')::numeric
            ELSE NULL
          END AS total,
          o.created_at,
          jsonb_strip_nulls(jsonb_build_object(
            'order_status', o.metadata->'order_status',
            'estimate_status', o.metadata->'estimate_status',
            'computed_total', o.metadata->'computed_total',
            'sales_rep', o.metadata->'sales_rep',
            'qb_estimate', o.metadata->'qb_estimate',
            'qb_estimate_txn_id', o.metadata->'qb_estimate_txn_id',
            'qb_estimate_operation_id', o.metadata->'qb_estimate_operation_id',
            'qb_sync_status', o.metadata->'qb_sync_status',
            'pos_created', o.metadata->'pos_created',
            'order_id', o.metadata->'order_id',
            'qb_estimate_ref', o.metadata->'qb_estimate_ref',
            'qb_estimate_ref_num', o.metadata->'qb_estimate_ref_num'
          )) AS metadata,
          CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
            'first_name', c.first_name,
            'last_name', c.last_name,
            'email', c.email,
            'phone', c.phone,
            'company_name', c.company_name
          ) END AS customer,
          CASE WHEN sc.id IS NULL THEN NULL ELSE jsonb_build_object(
            'name', sc.name
          ) END AS sales_channel
        FROM "order" o
        LEFT JOIN customer c
          ON c.id = o.customer_id
         AND c.deleted_at IS NULL
        LEFT JOIN sales_channel sc
          ON sc.id = o.sales_channel_id
         AND sc.deleted_at IS NULL
        LEFT JOIN order_summary summary
          ON summary.order_id = o.id
         AND summary.version = o.version
         AND summary.deleted_at IS NULL
        WHERE ${filters.join(" AND ")}
        ORDER BY o.created_at DESC
      `,
      bindings
    );

    const draftOrders = (result.rows ?? []).map((row) => ({
      ...row,
      total: row.total == null ? null : Number(row.total),
    }));
    return res.json({
      draft_orders: draftOrders,
      count: draftOrders.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown estimate filter error";
    return res.status(500).json({
      error: "estimate_filter_failed",
      message,
      draft_orders: [],
      count: 0,
    });
  }
}

export const AUTHENTICATE = ["user"];
