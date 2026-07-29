/**
 * verify-list-scope-reachability.ts
 *
 * Proves that the POS list routes can reach their own population, and that the
 * badge above a table is counted over the SAME set as the table.
 *
 * Three failures this exists to catch, all of them seen in production:
 *   1. A filter applied in the browser over whatever rows were already fetched.
 *      /invoices resolved the sales rep that way against a most-recent-200
 *      feed, so rep MFP showed 105 of its 605 invoices and rep JTV — both of
 *      whose invoices predate that window — showed as having none at all.
 *   2. A count endpoint that ignores a filter the table applies. /estimates
 *      filtered its rows by rep server-side but counted every rep, so picking
 *      AVP showed 5 rows under a badge of 185.
 *   3. A hard ceiling with no continuation. /transactions rendered one 200-row
 *      page of 1,297 payments with nothing on screen saying so.
 *
 * Every expectation is computed from SQL at run time rather than hardcoded, so
 * this keeps working as the data grows. Read-only: only GETs and SELECTs.
 *
 * Usage:
 *   BASE_URL=http://localhost:9099 \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   DB_URL=postgres://... \
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-list-scope-reachability.ts
 */

import { Client } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL ?? "";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  const mark = ok ? "PASS" : "FAIL";
  const detail = ok ? `${JSON.stringify(actual)}` : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`;
  console.log(`  [${mark}] ${label} — ${detail}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("login returned no token");
  return body.token;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type RepRow = { initials: string; name: string };
type InvoiceRow = { id: string; status: string };

/** Mirrors the POS `fetchInvoicePages`: read pages until one comes back short. */
async function exhaustInvoices(query: string, token: string): Promise<InvoiceRow[]> {
  const pageSize = 500;
  const out: InvoiceRow[] = [];
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const page = await get<{ invoices: InvoiceRow[] }>(
      `/admin/invoices?${query}&list_view=1&limit=${pageSize}&offset=${offset}`,
      token
    );
    out.push(...page.invoices);
    if (page.invoices.length < pageSize) return out;
  }
  throw new Error("invoice list exceeded the 20,000-row safety limit");
}

async function main(): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
  }
  if (!DB_URL) throw new Error("DB_URL (or DATABASE_URL) is required");

  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const token = await login();
  console.log(`\nverify-list-scope-reachability → ${BASE_URL}\n`);

  // ── Sales reps present in the data ─────────────────────────────────────────
  const { rows: reps } = await db.query<RepRow>(
    `SELECT DISTINCT metadata->'sales_rep'->>'initials' AS initials,
                     metadata->'sales_rep'->>'name'     AS name
       FROM "order"
      WHERE deleted_at IS NULL
        AND jsonb_typeof(metadata->'sales_rep') = 'object'
        AND COALESCE(metadata->'sales_rep'->>'initials', '') <> ''
      ORDER BY 1`
  );
  console.log(`Sales reps in data: ${reps.map((r) => r.initials).join(", ") || "(none)"}\n`);

  // ── /invoices: rows and badge, per rep ─────────────────────────────────────
  console.log("/admin/invoices — rows and badge share one scope");
  for (const rep of reps) {
    const { rows } = await db.query<{ total: string; non_voided: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE i.status <> 'voided')::text AS non_voided
         FROM pos_invoice i
         JOIN "order" o ON o.id = i.order_id AND o.deleted_at IS NULL
        WHERE i.deleted_at IS NULL
          AND ( COALESCE(o.metadata->'sales_rep'->>'initials','') IN ($1,$2)
             OR COALESCE(o.metadata->'sales_rep'->>'name','')     IN ($1,$2) )`,
      [rep.initials, rep.name]
    );
    const expectedNonVoided = Number(rows[0].non_voided);
    const query = `repInitials=${encodeURIComponent(rep.initials)}&repName=${encodeURIComponent(rep.name)}`;

    // Exhaust the pages exactly the way the POS does. The route returns
    // whatever `limit` asks for and no more, which is precisely why a page that
    // issues one request can never reach a population larger than its limit.
    const invoices = await exhaustInvoices(query, token);
    const liveRows = invoices.filter((i) => i.status !== "voided").length;
    check(`${rep.initials}: rows returned`, liveRows, expectedNonVoided);

    const uniqueIds = new Set(invoices.map((i) => i.id)).size;
    check(`${rep.initials}: no duplicated rows`, uniqueIds, invoices.length);

    const counts = await get<{ counts: { all: number } }>(
      `/admin/invoices/counts?${query}&showVoided=false`,
      token
    );
    check(`${rep.initials}: badge equals rows`, counts.counts.all, expectedNonVoided);
  }

  // ── /estimates: badge honours the rep the table filters by ─────────────────
  console.log("\n/admin/draft-orders/counts — badge honours the rep");
  for (const rep of reps) {
    const { rows } = await db.query<{ visible: string }>(
      `SELECT COUNT(*)::text AS visible
         FROM "order" o
        WHERE o.deleted_at IS NULL AND o.is_draft_order = TRUE
          AND COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '')
              NOT IN ('Not Approved','not_approved','Cancelled','cancelled','Voided','voided')
          AND ( COALESCE(o.metadata->'sales_rep'->>'initials','') IN ($1,$2)
             OR COALESCE(o.metadata->'sales_rep'->>'name','')     IN ($1,$2) )`,
      [rep.initials, rep.name]
    );
    const query = `repInitials=${encodeURIComponent(rep.initials)}&repName=${encodeURIComponent(rep.name)}`;
    const counts = await get<{ visibleCount: number }>(
      `/admin/draft-orders/counts?${query}`,
      token
    );
    check(`${rep.initials}: estimates badge`, counts.visibleCount, Number(rows[0].visible));

    const list = await get<{ draft_orders: Array<{ id: string }> }>(
      `/admin/draft-orders/filter?${query}`,
      token
    );
    check(`${rep.initials}: estimates rows equal badge`, list.draft_orders.length, Number(rows[0].visible));
  }

  // ── An empty rep token must not widen the filter ───────────────────────────
  console.log("\nEmpty rep token is not a filter that matches everything");
  {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "order"
        WHERE deleted_at IS NULL AND is_draft_order = TRUE
          AND COALESCE(metadata->>'order_status', metadata->>'estimate_status','')
              NOT IN ('Not Approved','not_approved','Cancelled','cancelled','Voided','voided')`
    );
    const all = await get<{ visibleCount: number }>(`/admin/draft-orders/counts`, token);
    check("no rep param → every estimate", all.visibleCount, Number(rows[0].n));
    const blank = await get<{ visibleCount: number }>(
      `/admin/draft-orders/counts?repInitials=&repName=`,
      token
    );
    check("blank rep params → every estimate (not zero, not a subset)", blank.visibleCount, Number(rows[0].n));
  }

  // ── /customer-payments: offset paginates the whole ledger ──────────────────
  console.log("\n/admin/customer-payments — pagination reaches the whole ledger");
  {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM customer_payment WHERE deleted_at IS NULL`
    );
    const total = Number(rows[0].n);

    const pageSize = 500;
    const seen = new Set<string>();
    let fetched = 0;
    for (let offset = 0; offset < total + pageSize; offset += pageSize) {
      const page = await get<{ payments: Array<{ id: string }> }>(
        `/admin/customer-payments?limit=${pageSize}&offset=${offset}`,
        token
      );
      fetched += page.payments.length;
      for (const p of page.payments) seen.add(p.id);
      if (page.payments.length < pageSize) break;
    }
    check("union of pages equals the ledger", seen.size, total);
    check("no payment returned twice across pages", fetched, seen.size);

    const firstPage = await get<{ payments: Array<{ id: string }> }>(
      `/admin/customer-payments?limit=${pageSize}&offset=0`,
      token
    );
    check(
      "one page alone is short of the ledger (the bug's shape)",
      firstPage.payments.length < total || total <= pageSize,
      true
    );
  }

  // ── /vendor-bills: the exact count is reachable ────────────────────────────
  console.log("\n/admin/vendor-bills — rows reach the count the route reports");
  {
    const pageSize = 200;
    const first = await get<{ vendor_bills: Array<{ id: string }>; count: number }>(
      `/admin/vendor-bills?limit=${pageSize}&offset=0`,
      token
    );
    const seen = new Set(first.vendor_bills.map((b) => b.id));
    for (let offset = pageSize; offset < first.count; offset += pageSize) {
      const page = await get<{ vendor_bills: Array<{ id: string }> }>(
        `/admin/vendor-bills?limit=${pageSize}&offset=${offset}`,
        token
      );
      for (const b of page.vendor_bills) seen.add(b.id);
    }
    check("exhausted pages equal the reported count", seen.size, first.count);

    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM vendor_bill WHERE deleted_at IS NULL`
    );
    check("reported count equals the table", first.count, Number(rows[0].n));
  }

  await db.end();

  console.log(
    `\n${failures === 0 ? "ALL GREEN" : "FAILURES"} — ${checks - failures}/${checks} checks passed\n`
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nverify-list-scope-reachability crashed: ${err.message}\n`);
  process.exit(1);
});
