/** Real sandbox HTTP, PostgreSQL, browser, atomic posting and closed-period races. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { POS_USER_MODULE } from "../../modules/pos-user";
import { POST as postRoute } from "../../api/admin/banking/accounting/transactions/[id]/post/route";
import { POST as reverseRoute } from "../../api/admin/banking/accounting/transactions/[id]/reverse/route";
import { POST as draftRoute } from "../../api/admin/banking/accounting/transactions/[id]/route";
import { POST as previewRoute } from "../../api/admin/banking/accounting/transactions/[id]/preview/route";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { periodBlockedSessions } from "../../lib/banking/opening-sandbox-periods";
import { accountingSource } from "../../lib/banking/accounting-source";
import { readAccountingTransaction } from "../../lib/banking/accounting-read";
import { postAccountingExpense, previewAccountingExpense } from "../../lib/banking/accounting-core";
import { bankExpenseCents } from "../../lib/banking/accounting-types";
import { fetchBankExpenseCostLines } from "../../api/admin/reports/_lib/bank-expense-costs";
import { account, actor, prefix, day, laterDay, closeNote, fingerprints, bankingFingerprint, seedAccount, seedMovement, cleanFixtures, journalNegativeControls } from "./bank-accounting-fixtures";

type Value = Record<string, unknown>;
type Context = Awaited<ReturnType<typeof readAccountingTransaction>>;
let checks = 0;
function check(value: unknown, label: string): asserts value { assert(value, label); checks++; console.log(`PASS ${label}`); }
function record(value: unknown): Value { assert(value && typeof value === "object" && !Array.isArray(value)); return value as Value; }
async function rejectCode(call: () => Promise<unknown>, code: string) {
  await assert.rejects(call, error => Boolean(error && typeof error === "object" && "code" in error && error.code === code)); checks++;
}
async function deniedRoutes(id: string) {
  assert(Number((await getDbPool().query("SELECT count(*) n FROM bank_review_permission")).rows[0].n) < 25);
  await getDbPool().query(`INSERT INTO bank_review_permission(id,user_id,can_review,can_close,can_post,granted_by)
    VALUES('brp_e2e_accounting_v8_staff',$1,true,true,false,$2)`, [actor + "_staff", actor]);
  const request = { auth_context: { actor_id: actor + "_staff" }, params: { id }, body: {}, headers: { "idempotency-key": randomUUID() },
    scope: { resolve: (name: string) => {
      if (name === "user") return { retrieveUser: async () => ({ email: "v8-staff@example.invalid" }) };
      if (name === POS_USER_MODULE) return { listPosUsers: async () => [{ can_view_accounting: true }] };
      throw new Error(`Unexpected route dependency ${name}`);
    } } } as unknown as AuthenticatedMedusaRequest;
  for (const route of [draftRoute, previewRoute, postRoute, reverseRoute]) {
    let status = 200; let result: Value = {};
    const response = { status: (value: number) => { status = value; return response; }, json: (value: Value) => { result = value; return response; } };
    await route(request, response as unknown as MedusaResponse);
    check(status === 403 && result.code === "BANKING_ACCESS_DENIED", "Executing route rejects accounting reader without separate post permission");
  }
  return async (route: typeof postRoute, body: Value, transactionId = id) => {
    request.body = body; request.params.id = transactionId; request.headers["idempotency-key"] = randomUUID();
    let status = 200; let result: Value = {};
    const response = { status: (value: number) => { status = value; return response; }, json: (value: Value) => { result = value; return response; } };
    await route(request, response as unknown as MedusaResponse);
    check(status === 200, `Explicit can_post actor executing handler succeeds (${String(result.code ?? "ok")})`);
    return result;
  };
}

async function main() {
  configureBankSandbox(); process.env.POS_URL = "http://localhost:3099";
  // banking-on-gl: configureBankSandbox() (src/lib/banking/sandbox-runtime.ts,
  // out of scope to edit) hardcodes DATABASE_URL=.../medusa and :9099 for the
  // shared sandbox; override here, defaults unchanged, to target ept-banking-gl.
  process.env.DATABASE_URL = process.env.BANKING_SANDBOX_DATABASE_URL ?? process.env.DATABASE_URL;
  const sandboxApiBase = process.env.BANKING_SANDBOX_API_BASE ?? "http://localhost:9099";
  process.env.MEDUSA_SANDBOX_URL = sandboxApiBase;
  const pool = getDbPool(); const client = await pool.connect(); let owned = false; let jwt = "";
  let before: Record<string, unknown> | undefined;
  let banksBefore: Record<string, unknown> | undefined;
  const base = (id: string) => `/admin/banking/accounting/transactions/${id}`;
  const api = async (path: string, body?: Value, status = 200, key = randomUUID(), anonymous = false) => {
    const response = await fetch(`${sandboxApiBase}${path}`, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(!anonymous && jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(body ? { "Idempotency-Key": key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const value = record(await response.json());
    check(response.status === status, `${path} HTTP ${response.status} expected ${status}; code ${String(value.code ?? "none")}`); return value;
  };
  const context = async (id: string) => await api(base(id)) as Context;
  const journalCount = async () => Number((await client.query("SELECT count(*) n FROM bank_journal_entry WHERE starts_with(transaction_id,$1)", [prefix])).rows[0].n);
  const mutate = async (sql: string, values: unknown[]) => transaction(client, async () => { await withReviewLock(client); await client.query(sql, values); });
  const waitForBlockedSessions = async (expected: number) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await periodBlockedSessions(client) >= expected) return;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`Expected ${expected} real blocked advisory-lock sessions`);
  };
  const confirm = async (id: string, category: string) => {
    await api(`/admin/banking/transactions/${id}/review`, { expected_revision: 0, expected_source_version: 1,
      mode: "categorize", category_list_id: category, comment: "Synthetic owned v8 evidence" });
    await api(`/admin/banking/transactions/${id}/confirm`, { expected_revision: 1, expected_source_version: 1 });
  };
  const draft = async (id: string, reference = `EPT-V8-${id}`) => {
    const live = await context(id);
    return await api(base(id), { expected_revision: live.draft?.revision ?? 0, source_hash: live.source_hash,
      nature: "new_direct_expense", reference, description: "Owned synthetic direct bank expense", attested: true,
      dismissals: live.candidates.filter(c => !c.definite).map(c => ({ key: c.key, reason: "Unrelated existing document; isolated synthetic bank verification" })) }) as Context;
  };
  const preview = async (id: string) => api(`${base(id)}/preview`, { expected_revision: (await context(id)).draft!.revision });
  const postBody = async (id: string) => ({ expected_revision: (await context(id)).draft!.revision, preview_hash: String((await preview(id)).preview_hash) });
  const report = async (month: "08" | "09") => {
    const query = `from=2026-${month}-01&to=2026-${month}-${month === "08" ? "31" : "30"}`;
    const docs = await api(`/admin/reports/expenses/documents?${query}`);
    const pnl = record((await api(`/admin/reports/profit-loss/statement?${query}`)).current);
    return { rows: docs.documents as Value[], expense: Math.round(Number(record(pnl.expense).total) * 100), income: Math.round(Number(pnl.net_income) * 100) };
  };
  try {
    owned = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-accounting-v8',7241)) ok")).rows[0].ok);
    check(owned, "Only one v8 harness owns the fixtures"); before = await fingerprints(client); await cleanFixtures(client);
    check(!(await client.query(`SELECT 1 FROM bank_day_close WHERE day=$1 UNION ALL
      SELECT 1 FROM bank_review_event WHERE entity_type IN ('day','command') AND entity_id=$1`, [day])).rowCount,
    "Daily fixture has no unrelated close or event history");
    banksBefore = await bankingFingerprint(client); await seedAccount(client);
    jwt = String((await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" })).token);
    await api(base(prefix + "nonexistent"), undefined, 404);
    const emptyList = await api(`/admin/banking/accounting/transactions?account_id=${prefix}nonexistent`);
    check(Array.isArray(emptyList.transactions) && emptyList.transactions.length === 0, "Accounting SQL binds an impossible account without matching sources");
    const emptyProjection = await fetchBankExpenseCostLines({ raw: (sql, bindings) => {
      let index = 0; return client.query<Value>(sql.replace(/\?/g, () => `$${++index}`), bindings);
    } }, "1900-01-01T05:00:00Z", "1900-01-02T05:00:00Z");
    check(emptyProjection.length === 0, "Actual bank expense projection binds both date parameters against an empty interval");
    const category = String((await client.query("SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Expense' AND (currency IS NULL OR currency IN ('USD','US Dollar')) ORDER BY qb_list_id LIMIT 1")).rows[0]?.qb_list_id ?? "");
    check(category, "Existing real Expense category available without writing QB cache");
    const id = await seedMovement(client, "main"); await api(base(id), undefined, 401, undefined, true);
    const permittedRoute = await deniedRoutes(id);
    check((await context(id)).blockers.includes("BANKING_EXPENSE_CONFIRMED_CATEGORY_REQUIRED"), "Unreviewed source cannot become an expense");
    await confirm(id, category); check(await journalCount() === 0, "Review confirmation alone creates zero journal entries");
    const closing = await api(`/admin/banking/daily?date=${day}`);
    check(closing.status !== "closed" && !closing.can_close, "Unconfigured companion account correctly blocks whole-day closure");
    const failedDay = await api("/admin/banking/daily/confirm", { date: day, expected_revision: closing.revision, input_hash: closing.input_hash }, 409);
    check(failedDay.code === "BANKING_DAY_NOT_READY" && await journalCount() === 0, "Rejected daily confirmation creates zero journal entries");
    const ownedSnapshot = { date: day, accounts: (closing.accounts as Value[]).filter(block => record(block.account).id === account) };
    check(ownedSnapshot.accounts.length === 1, "Closed-day fixture contains only owned banking evidence");
    assert(Number((await client.query("SELECT count(*) n FROM bank_day_close")).rows[0].n) < 62);
    await mutate(`INSERT INTO bank_day_close(id,day,revision,status,snapshot,input_hash,closed_by,closed_at)
      VALUES('bdc_e2e_accounting_v8',$1,1,'closed',$2::jsonb,$3,$4,now())`, [day, JSON.stringify(ownedSnapshot), closing.input_hash, actor]);
    const daily = (await client.query("SELECT id,snapshot FROM bank_day_close WHERE day=$1 AND status='closed'", [day])).rows[0];
    check(daily && JSON.stringify(daily.snapshot).includes(account), "Simulated closed-day snapshot retains confirmed source evidence");
    check(await journalCount() === 0, "Persisted closed-day evidence does not auto-post accounting");
    const baseline = await report("08"); const nextBaseline = await report("09");
    await draft(id); check(await journalCount() === 0, "Expense draft has zero journal effect");
    assert.deepEqual(await report("08"), baseline, "Expense draft has zero Expenses/P&L effect"); checks++;
    await client.query("UPDATE bank_review_permission SET can_post=true WHERE id='brp_e2e_accounting_v8_staff'");
    const staffPreview = await permittedRoute(previewRoute, { expected_revision: (await context(id)).draft!.revision });
    check(typeof staffPreview.preview_hash === "string", "Independent can_post allows real accounting preview with review/close unchanged");
    const body = await postBody(id); const key = randomUUID();
    const posted = await api(`${base(id)}/post`, body, 200, key) as Context;
    check(posted.posting?.amount_cents === 12001 && posted.history.length === 1, "$120.01 posts one exact-cent journal");
    const postReport = await report("08");
    check(postReport.rows.filter(row => row.document_id === posted.posting!.id && row.source === "bank_expense").length === 1,
      "Expenses contains the posted journal exactly once");
    check(postReport.expense - baseline.expense === 12001 && postReport.income - baseline.income === -12001, "P&L includes the expense once with correct sign");
    assert.deepEqual((await client.query("SELECT snapshot FROM bank_day_close WHERE id=$1", [daily.id])).rows[0].snapshot, daily.snapshot); checks++;
    const retried = await api(`${base(id)}/post`, body, 200, key) as Context;
    check(retried.posting?.id === posted.posting!.id && await journalCount() === 1, "Exact retry returns the committed original");
    await api(`${base(id)}/post`, { ...body, preview_hash: "0".repeat(64) }, 409, key);
    const lines = (await client.query("SELECT role,debit_cents::int,credit_cents::int FROM bank_journal_line WHERE entry_id=$1 ORDER BY role", [posted.posting!.id])).rows;
    assert.deepEqual(lines, [{ role: "bank", debit_cents: 0, credit_cents: 12001 }, { role: "expense", debit_cents: 12001, credit_cents: 0 }]); checks++;
    checks += await journalNegativeControls(client, posted.posting!.id);
    await assert.rejects(client.query("UPDATE bank_journal_entry SET description='mutant' WHERE id=$1", [posted.posting!.id]), /BANKING_JOURNAL_IMMUTABLE/); checks++;
    const dayState = await api(`/admin/banking/daily?date=${day}`);
    await api("/admin/banking/daily/reopen", { date: day, expected_revision: dayState.revision, reason: "Owned v8 fixtures need later cases" });
    const original = (await client.query("SELECT to_jsonb(e) data FROM bank_journal_entry e WHERE id=$1", [posted.posting!.id])).rows[0].data;
    for (const [sql, values] of [
      ["UPDATE bank_transaction SET source_version=2,name='Source changed after posting' WHERE id=$1", [id]],
      ["UPDATE bank_transaction SET transaction_date='2026-08-18' WHERE id=$1", [id]],
      ["UPDATE bank_transaction SET status='removed' WHERE id=$1", [id]],
    ] as [string, unknown[]][]) {
      await mutate(sql, values); check((await context(id)).history[0]!.stale, "Changed/dated/removed source exposes immutable journal drift");
      assert.deepEqual((await client.query("SELECT to_jsonb(e) data FROM bank_journal_entry e WHERE id=$1", [posted.posting!.id])).rows[0].data, original); checks++;
    }
    await api(`${base(id)}/reverse`, { posting_id: posted.posting!.id, day: "2026-08-16", reason: "Cannot predate the original" }, 409);
    const reversed = await api(`${base(id)}/reverse`, { posting_id: posted.posting!.id, day: laterDay, reason: "Explicit later-period correction" }) as Context;
    check(reversed.history.length === 2 && reversed.history[1]!.day === laterDay, "Later-date reversal preserves historical accounting date");
    const past = await report("08"); const future = await report("09");
    check(past.expense === postReport.expense && past.income === postReport.income, "September reversal does not restate August P&L");
    check(future.expense - nextBaseline.expense === -12001 && future.income - nextBaseline.income === 12001, "Reversal reduces September expense exactly once");
    const amounts = (await client.query(`SELECT e.day,sum(l.debit_cents-l.credit_cents)::int cents FROM bank_journal_entry e
      JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='expense' WHERE e.transaction_id=$1 GROUP BY e.day ORDER BY e.day`, [id])).rows;
    assert.deepEqual(amounts, [{ day, cents: 12001 }, { day: laterDay, cents: -12001 }]); checks++;
    const race = await seedMovement(client, "race", "121.03"); await confirm(race, category); await draft(race); const raceBody = await postBody(race);
    for (const who of [actor + "_a", actor + "_b"]) await previewAccountingExpense(race, who, randomUUID(), { expected_revision: raceBody.expected_revision });
    const results = await Promise.allSettled([postAccountingExpense(race, actor + "_a", randomUUID(), raceBody), postAccountingExpense(race, actor + "_b", randomUUID(), raceBody)]);
    check(results.filter(result => result.status === "fulfilled").length === 1, "Two actors and keys can claim an economic source only once");
    check((await client.query("SELECT count(*)::int n FROM bank_journal_entry WHERE transaction_id=$1", [race])).rows[0].n === 1, "Race persists exactly one journal");
    const staffTx = await seedMovement(client, "staff", "7.31"); await confirm(staffTx, category); await draft(staffTx);
    const staffVersion = (await context(staffTx)).draft!.revision;
    const staffHash = await permittedRoute(previewRoute, { expected_revision: staffVersion }, staffTx);
    await permittedRoute(postRoute, { expected_revision: staffVersion, preview_hash: staffHash.preview_hash }, staffTx);
    check((await client.query("SELECT actor_id FROM bank_journal_entry WHERE transaction_id=$1", [staffTx])).rows[0].actor_id === actor + "_staff",
      "Delegated can_post permission writes the journal through the executing route");
    const known = (await client.query("SELECT id,number FROM vendor_bill WHERE deleted_at IS NULL AND status IN ('draft','confirmed','synced') AND number IS NOT NULL ORDER BY id LIMIT 1")).rows[0];
    check(known, "Read-only existing bill supports definite and ambiguous reference controls");
    const duplicate = await seedMovement(client, "duplicate", "14.71"); await confirm(duplicate, category);
    const linked = await draft(duplicate, `vendor_bill:${String(known.id)}`);
    check(linked.candidates.some(candidate => candidate.definite && candidate.id === known.id), "Explicit bill ID is a definite already-recognized source");
    const blocked = await api(`${base(duplicate)}/preview`, { expected_revision: linked.draft!.revision }, 409);
    check(blocked.code === "BANKING_EXPENSE_ALREADY_RECOGNIZED", "Definite source cannot become a second expense");
    const ambiguous = await draft(duplicate, String(known.number));
    const unresolved = await api(`${base(duplicate)}/preview`, { expected_revision: ambiguous.draft!.revision }, 409);
    check(unresolved.code === "BANKING_EXPENSE_UNRESOLVED_CANDIDATE", "Ambiguous reference remains pending until explicitly resolved");
    await api(base(duplicate), { expected_revision: ambiguous.draft!.revision, source_hash: ambiguous.source_hash, nature: "payroll",
      reference: "Outside scope", description: "Unknown source", attested: true, dismissals: [] }, 400);
    for (const amount of ["0", "-1", "0.001", "120.010", "1e2", "9999999999.999"]) {
      assert.throws(() => bankExpenseCents(amount), /BANKING_EXPENSE_AMOUNT_INVALID/); checks++;
    }
    const bad = await seedMovement(client, "unsupported"); await confirm(bad, category);
    for (const [sql, values, code] of [
      ["UPDATE bank_transaction SET currency='CAD' WHERE id=$1", [bad], "BANKING_EXPENSE_USD_REQUIRED"],
      ["UPDATE bank_transaction SET currency='USD',amount='1.001' WHERE id=$1", [bad], "BANKING_EXPENSE_AMOUNT_INVALID"],
      ["UPDATE bank_transaction SET amount='120.01',status='pending' WHERE id=$1", [bad], "BANKING_POSTED_TRANSACTION_REQUIRED"],
      ["UPDATE bank_account SET type='credit' WHERE id=$1", [account], "BANKING_EXPENSE_DEPOSITORY_REQUIRED"],
      ["UPDATE bank_account SET type='depository',qb_list_id=$2 WHERE id=$1", [account, category], "BANKING_EXPENSE_BANK_MAPPING_INVALID"],
    ] as [string, unknown[], string][]) {
      await mutate(sql, values); const src = await accountingSource(client, bad); check(src.blockers.includes(code), `Source guard rejects intended reason ${code}`);
    }
    await mutate("UPDATE bank_account SET qb_list_id=$2 WHERE id=$1", [account, posted.source.bank_account!.id]);
    const browserId = await seedMovement(client, "browser"); await confirm(browserId, category);
    const browser = await import(pathToFileURL(resolve(__dirname, "../../../../store-pos/scripts/e2e/bank-accounting.mjs")).href) as {
      runAccountingBrowser(input: { accountId: string; transactionId: string; day: string; reference: string; reverseDay: string; unsupportedTransactionId: string }): Promise<{ checks: number; journalId: string; reversalId: string }> };
    const ui = await browser.runAccountingBrowser({ accountId: account, transactionId: browserId, day, reference: "EPT-V8-BROWSER", reverseDay: laterDay, unsupportedTransactionId: bad });
    checks += ui.checks; check(Boolean(ui.journalId && ui.reversalId), "Permitted real UI posted and reversed through backend");
    // Empty historical period is independent of operator months; actual Month Close still captures inventory.
    const month = "2000-01"; const readiness = await api(`/admin/accounting/month-close?month=${month}`);
    check(readiness.status === "open" && !record(readiness.readiness).has_blockers, "Separate empty ended month is safe for real close/reopen");
    check(!(await client.query("SELECT 1 FROM accounting_period_close WHERE period_start='2000-01-01'")).rowCount, "Period fixture has no unrelated close history");
    const count = (await client.query(`SELECT count(*)::int n FROM inventory_level il JOIN inventory_item ii ON ii.id=il.inventory_item_id
      JOIN product_variant_inventory_item p ON p.inventory_item_id=ii.id JOIN product_variant v ON v.id=p.variant_id AND v.deleted_at IS NULL
      GROUP BY il.location_id`)).rows;
    check(count.every(row => row.n <= 5000), "Inventory snapshot preflight <=5000 lines per location");
    const anchor = await seedMovement(client, "month_anchor", "2.11", "2000-01-03"); await confirm(anchor, category); await draft(anchor);
    const anchorPosting = await api(`${base(anchor)}/post`, await postBody(anchor)) as Context;
    const monthTx = await seedMovement(client, "month", "3.17", "2000-01-17"); await confirm(monthTx, category); await draft(monthTx); const monthBody = await postBody(monthTx);
    await previewAccountingExpense(monthTx, actor, randomUUID(), { expected_revision: monthBody.expected_revision });
    const blockedTx = await seedMovement(client, "closed_period", "4.19", "2000-01-18"); await confirm(blockedTx, category); await draft(blockedTx);
    const blockedBody = await postBody(blockedTx); await previewAccountingExpense(blockedTx, actor, randomUUID(), { expected_revision: blockedBody.expected_revision });
    await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtextextended('accounting-period:2000-01',7242))");
    let closeSettled = false; let postSettled = false;
    const closePromise = api("/admin/accounting/month-close", { month, acknowledge_warnings: true, note: closeNote }, 201).finally(() => { closeSettled = true; });
    const postPromise = postAccountingExpense(monthTx, actor, randomUUID(), monthBody).finally(() => { postSettled = true; });
    const outcomes = Promise.allSettled([closePromise, postPromise]);
    await waitForBlockedSessions(2); check(!closeSettled && !postSettled, "Real month close and posting are observed blocked on the same advisory lock");
    await client.query("COMMIT"); const monthResults = await outcomes;
    check(monthResults[0]!.status === "fulfilled", "Actual Month Close commits complete inventory snapshots");
    await rejectCode(() => postAccountingExpense(blockedTx, actor, randomUUID(), blockedBody), "BANKING_ACCOUNTING_PERIOD_CLOSED");
    const closedReverse = await api(`${base(anchor)}/reverse`, { posting_id: anchorPosting.posting!.id, day: "2000-01-20", reason: "Closed month must reject reversal" }, 423);
    check(closedReverse.code === "BANKING_ACCOUNTING_PERIOD_CLOSED", "Reversal checks its explicit accounting period");
    await api(`${base(anchor)}/reverse`, { posting_id: anchorPosting.posting!.id, day: "2000-02-01", reason: "Open subsequent period correction" });
    const reopen = record((await api(`/admin/accounting/month-close/reopen-preview?month=${month}`)).preview);
    await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtextextended('accounting-period:2000-01',7242))");
    let reopenSettled = false;
    const reopening = api("/admin/accounting/month-close/reopen", { month, input_hash: reopen.input_hash, reason: "Owned v8 test reopening" }).finally(() => { reopenSettled = true; });
    await waitForBlockedSessions(1); check(!reopenSettled, "Real reopen is observed blocked on the shared advisory lock");
    await client.query("COMMIT"); await reopening;
    const afterMonth = await context(monthTx);
    if (!afterMonth.posting) await api(`${base(monthTx)}/post`, await postBody(monthTx));
    check(Boolean((await context(monthTx)).posting), "Reopened period allows the source to post");
    console.log(`PASS v8 database/HTTP/browser checks=${checks}`);
  } finally {
    try { if (owned) {
      await client.query("ROLLBACK"); await cleanFixtures(client);
      if (before) { assert.deepEqual(await fingerprints(client), before, "All protected financial/China/payroll/stock evidence unchanged"); checks++; }
      if (banksBefore) { assert.deepEqual(await bankingFingerprint(client), banksBefore, "Operator banking evidence restored byte-for-byte by scoped cleanup"); checks++; }
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-accounting-v8',7241))");
    } } finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank accounting integration: ${checks} checks; owned residue=0; protected sources unchanged`);
}
void main().catch((error: unknown) => { console.error(`V8 verification failed after ${checks} checks`, error instanceof Error ? error.message : "UNKNOWN_ERROR"); process.exitCode = 1; });
