/**
 * verify-gl-reports.ts — gate of the GL reports (register, P&L, balance
 * sheet, sales tax, chart of accounts) against a LIVE backend + its database.
 *
 * Run (sandbox):
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_bankgl' \
 *   GL_API_BASE='http://localhost:9096' \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-gl-reports.ts
 *
 * Credentials: GL_API_EMAIL / GL_API_PASSWORD (default: the sandbox admin).
 * The user must be an OWNER (`POS_OWNER_EMAILS` on the backend) — (f) writes.
 *
 * Sections:
 *   (a) accounting identity as of today: assets = liabilities + equity, `balanced`
 *   (b) trial-balance closing == register closing (3 busiest Bank + AR)
 *   (c) P&L year-to-date net income == balance-sheet net_income_cents
 *   (d) sales-tax `tax_collected_cents` of last month == Σ invoice.tax − Σ CM.tax
 *   (e) register: last row's running balance == closing (paged to the end)
 *   (f) accounts POST → PATCH rename → PATCH deactivate round trip (left inactive)
 *   (g) non-vacuity: every check above ran over real rows
 *   (h) NO account differs between the trial-balance endpoint and a direct
 *       pair-cancelled recomputation — regression guard for the 2026-09-11
 *       bug (reversal mirror lines counted). Before the fix the four accounts
 *       in BEFORE_FIX_DELTAS were off by exactly those amounts.
 *   (i) statement hierarchy (audit P1-2): on every P&L / balance-sheet
 *       section, for each parent row `Σ children.cents + own_cents == cents`
 *       (the "<Parent> – Other" line closes the identity) and a leaf has
 *       own == cents. Requires at least one parent WITH own postings so the
 *       "– Other" branch is exercised, not vacuous.
 *   (j) chart of accounts (audit P1-3): `balance_rollup_cents` of every
 *       balance-sheet account == the balance sheet's row `cents` as of today,
 *       and `balance_own_cents` == what its subtree recomputes; requires ≥1
 *       account where rollup ≠ own (Loan Receivable-style) so it is not vacuous.
 *
 * Mutation-tested (see the report in the session that added it):
 *   (a) flip the sign of equity in the BS aggregation → red
 *   (h) revert the trial-balance predicate to "exclude only the original" → red
 */
import { Pool } from "pg";

import { getBusinessDateString } from "../../lib/date/et";
import { activeEntryPredicate } from "../../lib/ledger/reports/active-entries";

const API = process.env.GL_API_BASE ?? "http://localhost:9096";
const EMAIL = process.env.GL_API_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.GL_API_PASSWORD ?? "sandbox123";

/** Measured on medusa_bankgl before the predicate fix (cents, TB − pair-cancelled). */
const BEFORE_FIX_DELTAS: Array<[string, string, bigint]> = [
  ["80000006-1317847775", "Chase Bank Checking 7223", 312986n],
  ["80000167-1684269278", "Regions Bank Checking 1416", 10160590n],
  ["8000017B-1738860533", "TD Bank Checking 9209", 1284301n],
  ["80000047-1331073116", "Accounts Receivable", -4487n],
];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let token = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed as T };
}

async function login(): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${API}/auth/user/emailpass`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      if (res.ok) {
        token = ((await res.json()) as { token: string }).token;
        return;
      }
      throw new Error(`login ${res.status}`);
    } catch (error) {
      if (attempt === 6) throw error;
      console.log(`  … backend not ready (${String(error)}), retry ${attempt}/5 in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

type Cents = string;
interface StatementRow { list_id: string; name: string; depth: number; cents: Cents; own_cents: Cents; has_children: boolean }
interface Section { rows: StatementRow[]; total_cents: Cents }
interface BalanceSheet {
  assets: { current: Section; fixed: Section; other: Section; total_cents: Cents };
  liabilities: { current: Section; long_term: Section; total_cents: Cents };
  equity: { rows: StatementRow[]; retained_earnings_cents: Cents; net_income_cents: Cents; total_cents: Cents };
  total_assets_cents: Cents;
  total_liabilities_equity_cents: Cents;
  balanced: boolean;
}
interface ProfitLoss { income: Section; cogs: Section; expenses: Section; other_income: Section; other_expense: Section; net_income: { total_cents: Cents } }
interface TrialBalance {
  accounts: Array<{ list_id: string; account_type: string; normal_balance: string | null; closing_cents: Cents; has_activity: boolean }>;
}
interface Register {
  account: { normal_balance: string };
  opening_cents: Cents;
  rows: Array<{ balance_cents: Cents; reversed: boolean }>;
  closing_cents: Cents;
  next_cursor: string | null;
}
interface SalesTax {
  tax_collected_cents: Cents; taxable_sales_cents: Cents; by_month: unknown[];
  payable_opening_cents: Cents; payable_closing_cents: Cents; payments_cents: Cents;
  imported_tax_cents: Cents; adjustment_credits_cents: Cents;
}
interface Accounts { items: Array<{ list_id: string; full_name: string; is_active: boolean; is_pos_owned: boolean; account_number: string | null; balance_cents: Cents; balance_own_cents: Cents; balance_rollup_cents: Cents; has_children: boolean }> }

/**
 * (i) For every row of a section: children (the depth+1 rows that follow it
 * before the next row at ≤ its depth) + own == cents. Returns the violations
 * and how many parents carried own postings (the "– Other" branch).
 */
function checkSectionIdentity(rows: StatementRow[]): { bad: string[]; parents: number; withOther: number } {
  const bad: string[] = [];
  let parents = 0;
  let withOther = 0;
  rows.forEach((row, i) => {
    let sum = 0n;
    let children = 0;
    for (let j = i + 1; j < rows.length && rows[j].depth > row.depth; j++) {
      if (rows[j].depth === row.depth + 1) {
        sum += BigInt(rows[j].cents);
        children += 1;
      }
    }
    if (children === 0) {
      if (row.own_cents !== row.cents) bad.push(`${row.name}: leaf own ${row.own_cents} ≠ cents ${row.cents}`);
      return;
    }
    parents += 1;
    if (BigInt(row.own_cents) !== 0n) withOther += 1;
    if (sum + BigInt(row.own_cents) !== BigInt(row.cents)) {
      bad.push(`${row.name}: Σchildren ${sum} + other ${row.own_cents} ≠ ${row.cents}`);
    }
  });
  return { bad, parents, withOther };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("verify-gl-reports: DATABASE_URL is not set — no check without data.");
    process.exit(1);
    return;
  }
  const pool = new Pool({ connectionString: url });
  const today = getBusinessDateString();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  try {
    await login();

    console.log("\n(a) accounting identity as of today");
    const bs = await api<BalanceSheet>("GET", `/admin/accounting/ledger/balance-sheet?as_of=${today}`);
    check("balance-sheet answers 200", bs.status === 200, `status ${bs.status}`);
    const assets = BigInt(bs.body.total_assets_cents ?? "0");
    const liabEq = BigInt(bs.body.liabilities?.total_cents ?? "0") + BigInt(bs.body.equity?.total_cents ?? "0");
    check(`assets (${assets}) == liabilities + equity incl. RE + NI (${liabEq})`, assets === liabEq && assets === BigInt(bs.body.total_liabilities_equity_cents));
    check("balance-sheet reports balanced=true", bs.body.balanced === true);

    console.log("\n(b) trial-balance closing == register closing");
    const tb = await api<TrialBalance>("GET", `/admin/accounting/ledger/trial-balance?from=2000-01-01&to=${today}&include_zero=false`);
    check("trial-balance answers 200", tb.status === 200, `status ${tb.status}`);
    const { rows: busiest } = await pool.query<{ list_id: string }>(
      `SELECT l.account_list_id AS list_id FROM bank_journal_line l
         JOIN qb_account a ON a.qb_list_id = l.account_list_id
        WHERE a.account_type = 'Bank' GROUP BY 1 ORDER BY count(*) DESC LIMIT 3`
    );
    const targets = [...busiest.map((r) => r.list_id), "80000047-1331073116"];
    const registers = new Map<string, Register>();
    for (const listId of targets) {
      const tbRow = tb.body.accounts.find((a) => a.list_id === listId);
      let page = await api<Register>("GET", `/admin/accounting/ledger/register?account_list_id=${listId}&from=2000-01-01&to=${today}&limit=500`);
      const first = page.body;
      let last = page.body.rows[page.body.rows.length - 1];
      while (page.status === 200 && page.body.next_cursor) {
        page = await api<Register>("GET", `/admin/accounting/ledger/register?account_list_id=${listId}&from=2000-01-01&to=${today}&limit=500&cursor=${encodeURIComponent(page.body.next_cursor)}`);
        if (page.body.rows.length) last = page.body.rows[page.body.rows.length - 1];
      }
      registers.set(listId, { ...first, rows: last ? [last] : [] });
      const sign = (tbRow?.normal_balance ?? "debit") === "debit" ? 1n : -1n;
      const tbClosing = tbRow ? sign * BigInt(tbRow.closing_cents) : null;
      check(`${listId}: TB closing ${tbClosing} == register closing ${first.closing_cents}`, tbClosing !== null && tbClosing === BigInt(first.closing_cents));
    }

    console.log("\n(c) P&L year-to-date net income == balance-sheet net income");
    const pl = await api<ProfitLoss>("GET", `/admin/accounting/ledger/profit-loss?from=${yearStart}&to=${today}`);
    check("profit-loss answers 200", pl.status === 200, `status ${pl.status}`);
    check(`P&L net income ${pl.body.net_income?.total_cents} == BS net_income_cents ${bs.body.equity?.net_income_cents}`, pl.body.net_income?.total_cents === bs.body.equity?.net_income_cents);

    console.log("\n(d) sales tax collected last month == documents");
    const lastMonthEnd = new Date(`${yearStart.slice(0, 4)}-${today.slice(5, 7)}-01T12:00:00Z`);
    lastMonthEnd.setUTCDate(0);
    const lmTo = lastMonthEnd.toISOString().slice(0, 10);
    const lmFrom = `${lmTo.slice(0, 7)}-01`;
    const st = await api<SalesTax>("GET", `/admin/accounting/ledger/sales-tax?from=${lmFrom}&to=${lmTo}`);
    check("sales-tax answers 200", st.status === 200, `status ${st.status}`);
    const { rows: [docs] } = await pool.query<{ collected: string }>(
      `SELECT ((SELECT COALESCE(SUM(ROUND(tax)), 0) FROM pos_invoice
                 WHERE deleted_at IS NULL AND voided_at IS NULL AND status <> 'voided' AND issued_at IS NOT NULL
                   AND (issued_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date)
             - (SELECT COALESCE(SUM(ROUND(tax)), 0) FROM pos_credit_memo
                 WHERE deleted_at IS NULL AND voided_at IS NULL AND status = 'completed' AND completed_at IS NOT NULL
                   AND (completed_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date))::text AS collected`,
      [process.env.QB_DOC_TIMEZONE || "America/New_York", lmFrom, lmTo]
    );
    check(`${lmFrom}..${lmTo}: tax_collected ${st.body.tax_collected_cents} == Σinvoice.tax − ΣCM.tax ${docs?.collected}`, st.body.tax_collected_cents === docs?.collected);
    // (d2) the on-screen equation closes: opening + collected + imported + adjustments − paid == closing (audit P1-10)
    const qStart = `${today.slice(0, 4)}-${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
    const stq = await api<SalesTax>("GET", `/admin/accounting/ledger/sales-tax?from=${qStart}&to=${today}`);
    const lhs = BigInt(stq.body.payable_opening_cents ?? "0") + BigInt(stq.body.tax_collected_cents ?? "0") + BigInt(stq.body.imported_tax_cents ?? "0") + BigInt(stq.body.adjustment_credits_cents ?? "0") - BigInt(stq.body.payments_cents ?? "0");
    check(`${qStart}..${today}: opening + collected + imported (${stq.body.imported_tax_cents}) + adjustments (${stq.body.adjustment_credits_cents}) − paid == closing (${lhs} vs ${stq.body.payable_closing_cents})`, stq.status === 200 && lhs === BigInt(stq.body.payable_closing_cents ?? "1"));

    console.log("\n(e) register running balance ends at closing");
    for (const [listId, reg] of registers) {
      const last = reg.rows[0];
      check(`${listId}: last row balance ${last?.balance_cents} == closing ${reg.closing_cents}`, last !== undefined && last.balance_cents === reg.closing_cents);
    }

    console.log("\n(f) accounts POST / PATCH round trip");
    const name = `Verify GL Reports ${Date.now()}`;
    const created = await api<{ list_id: string }>("POST", "/admin/accounting/accounts", { name, account_type: "Expense", description: "verify-gl-reports" });
    check("POST creates a pos_ account (201)", created.status === 201 && created.body.list_id?.startsWith("pos_"), `status ${created.status} ${JSON.stringify(created.body)}`);
    const listId = created.body.list_id ?? "";
    const renamed = await api<{ ok: boolean }>("PATCH", `/admin/accounting/accounts/${listId}`, { name: `${name} renamed`, account_number: "69998" });
    check("PATCH renames + numbers (200)", renamed.status === 200, `status ${renamed.status}`);
    const busy = await api<{ code: string }>("PATCH", `/admin/accounting/accounts/${targets[0]}`, { is_active: false });
    check("PATCH deactivate with balance → 409 ACCOUNT_HAS_BALANCE", busy.status === 409 && busy.body.code === "ACCOUNT_HAS_BALANCE", `status ${busy.status} ${JSON.stringify(busy.body)}`);
    const off = await api<{ ok: boolean }>("PATCH", `/admin/accounting/accounts/${listId}`, { is_active: false });
    check("PATCH deactivates the zero-balance account (200)", off.status === 200, `status ${off.status}`);
    const listed = await api<Accounts>("GET", `/admin/accounting/accounts?include_inactive=true&q=${encodeURIComponent(name)}`);
    const item = listed.body.items?.find((i) => i.list_id === listId);
    check("GET lists it inactive, pos-owned, renamed, numbered", item?.is_active === false && item.is_pos_owned && item.full_name === `${name} renamed` && item.account_number === "69998", JSON.stringify(item));
    const activeOnly = await api<Accounts>("GET", `/admin/accounting/accounts?q=${encodeURIComponent(name)}`);
    check("GET without include_inactive hides it", !activeOnly.body.items?.some((i) => i.list_id === listId));

    console.log("\n(g) non-vacuity");
    check(`trial balance has ≥ 50 active accounts (${tb.body.accounts.filter((a) => a.has_activity).length})`, tb.body.accounts.filter((a) => a.has_activity).length >= 50);
    check(`P&L income total > 0 (${pl.body.income?.total_cents})`, BigInt(pl.body.income?.total_cents ?? "0") > 0n);
    check(`sales tax collected last month > 0 (${st.body.tax_collected_cents})`, BigInt(st.body.tax_collected_cents ?? "0") > 0n);
    check("balance sheet has equity rows or non-zero net income", (bs.body.equity?.rows?.length ?? 0) > 0 || BigInt(bs.body.equity?.net_income_cents ?? "0") !== 0n);
    const { rows: [pairs] } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_journal_entry WHERE reverses_entry_id IS NOT NULL AND deleted_at IS NULL`);
    check(`reversed pairs exist so (h) is meaningful (${pairs?.n})`, BigInt(pairs?.n ?? "0") > 0n);

    console.log("\n(h) trial balance == pair-cancelled recomputation, every account");
    const { rows: direct } = await pool.query<{ list_id: string; closing: string }>(
      `SELECT l.account_list_id AS list_id, COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS closing
         FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")} AND e.day <= $1
        GROUP BY 1`,
      [today]
    );
    const directMap = new Map(direct.map((r) => [r.list_id, BigInt(r.closing)]));
    const diffs: string[] = [];
    for (const a of tb.body.accounts) {
      const expected = directMap.get(a.list_id) ?? 0n;
      if (BigInt(a.closing_cents) !== expected) diffs.push(`${a.list_id}: TB ${a.closing_cents} vs direct ${expected}`);
    }
    check(`no account differs (${tb.body.accounts.length} compared)`, diffs.length === 0, diffs.slice(0, 5).join("; "));
    for (const [id, label, before] of BEFORE_FIX_DELTAS) {
      const tbRow = tb.body.accounts.find((a) => a.list_id === id);
      const delta = tbRow ? BigInt(tbRow.closing_cents) - (directMap.get(id) ?? 0n) : null;
      check(`${label}: delta before fix ${before}, now ${delta}`, delta === 0n);
    }

    console.log("\n(i) statements: children + '– Other' == parent, every section");
    const sections: Array<[string, Section | undefined]> = [
      ["P&L income", pl.body.income], ["P&L cogs", pl.body.cogs], ["P&L expenses", pl.body.expenses],
      ["P&L other_income", pl.body.other_income], ["P&L other_expense", pl.body.other_expense],
      ["BS assets.current", bs.body.assets?.current], ["BS assets.fixed", bs.body.assets?.fixed],
      ["BS assets.other", bs.body.assets?.other], ["BS liabilities.current", bs.body.liabilities?.current],
      ["BS liabilities.long_term", bs.body.liabilities?.long_term], ["BS equity", { rows: bs.body.equity?.rows ?? [], total_cents: "0" }],
    ];
    let parentsSeen = 0;
    let othersSeen = 0;
    for (const [label, sec] of sections) {
      const rows = sec?.rows ?? [];
      check(`${label}: every row carries own_cents/has_children`, rows.every((r) => typeof r.own_cents === "string" && typeof r.has_children === "boolean"), `${rows.length} rows`);
      const r = checkSectionIdentity(rows);
      parentsSeen += r.parents;
      othersSeen += r.withOther;
      check(`${label}: identity holds on ${r.parents} parent(s), ${r.withOther} with own postings`, r.bad.length === 0, r.bad.slice(0, 3).join("; "));
    }
    check(`(i) non-vacuous: ≥1 parent with children (${parentsSeen}) and ≥1 with own postings (${othersSeen})`, parentsSeen >= 1 && othersSeen >= 1);

    console.log("\n(j) chart of accounts roll-up == balance-sheet parent rows");
    const coa = await api<Accounts>("GET", "/admin/accounting/accounts?include_inactive=true");
    check("accounts answers 200 with balance_own_cents + balance_rollup_cents", coa.status === 200 && coa.body.items.every((a) => typeof a.balance_own_cents === "string" && typeof a.balance_rollup_cents === "string"), `status ${coa.status}`);
    const coaMap = new Map(coa.body.items.map((a) => [a.list_id, a]));
    const bsRows = [
      ...(bs.body.assets?.current?.rows ?? []), ...(bs.body.assets?.fixed?.rows ?? []), ...(bs.body.assets?.other?.rows ?? []),
      ...(bs.body.liabilities?.current?.rows ?? []), ...(bs.body.liabilities?.long_term?.rows ?? []), ...(bs.body.equity?.rows ?? []),
    ];
    const coaDiffs: string[] = [];
    let rollupDiffersFromOwn = 0;
    for (const r of bsRows) {
      const a = coaMap.get(r.list_id);
      if (!a) { coaDiffs.push(`${r.name}: missing from /accounts`); continue; }
      if (a.balance_rollup_cents !== r.cents) coaDiffs.push(`${r.name}: CoA rollup ${a.balance_rollup_cents} ≠ BS ${r.cents}`);
      if (a.balance_own_cents !== r.own_cents) coaDiffs.push(`${r.name}: CoA own ${a.balance_own_cents} ≠ BS own ${r.own_cents}`);
      if (a.balance_rollup_cents !== a.balance_own_cents) rollupDiffersFromOwn += 1;
    }
    check(`CoA balances match the balance sheet on ${bsRows.length} rows`, coaDiffs.length === 0, coaDiffs.slice(0, 5).join("; "));
    check(`(j) non-vacuous: ≥1 account where rollup ≠ own (${rollupDiffersFromOwn})`, rollupDiffersFromOwn >= 1);
    check("balance_cents keeps the OWN semantics (register closing)", coa.body.items.every((a) => a.balance_cents === a.balance_own_cents));
  } finally {
    await pool.end();
  }

  console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error("  • " + f);
    process.exit(1);
  }
  console.log("✅ verify-gl-reports");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
