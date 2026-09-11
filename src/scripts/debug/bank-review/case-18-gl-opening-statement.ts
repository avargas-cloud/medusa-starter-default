/**
 * Case 18 · GL opening balance → statement reconciliation, end-to-end (banking-on-gl).
 *
 * Sandbox override: `_lib.ts`'s `connect()`/`run()` pin API=:9099 and DATABASE_URL=.../medusa
 * (via `configureBankSandbox()`). This case targets the ept-banking-gl worktree instead:
 * `CASE_API` (default http://localhost:9096) and `CASE_DATABASE_URL`
 * (default postgresql://postgres:sandbox@localhost:5499/medusa_bgl). Per the task's own
 * instructions this script does NOT call `configureBankSandbox()`/`_lib.connect()` — it copies
 * the minimal login+pool wiring below instead of touching the shared `_lib.ts` (whose hardcoded
 * defaults every sibling case-NN script still relies on).
 *
 * FIXED BLOCKER (was here, now gone — commit 8759f1a0): `src/lib/banking/security.ts` used to
 * hardcode `SANDBOX_TARGET.pathname = "/medusa"`, so `requireBankingSandbox()` 503'd every
 * `/admin/banking/**` route against this worktree's `.../medusa_bgl`. The gate now accepts
 * `medusa_<sufijo>` clones; `GET /admin/banking` on :9096 responds `enabled:true`.
 *
 * FIXED BLOCKER #2 (was here, now gone — commit 1c1afe62): `statementBank()`'s opening-lookup
 * query (and 3 siblings in statement-match-sql/receipts-setup/receipts-source) were missing
 * `AND e.kind='document'`, so a stale `kind='reversal'` entry (which copies every role, `opening`
 * included, and is never itself reversed) satisfied the WHERE clause forever alongside the real
 * document, giving `opening.length===2` and a permanent `BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED`.
 * Verified fixed: `statementBank()`'s SQL now returns exactly 1 row for this account.
 *
 * FIXED BLOCKER #3 (was here, now gone — commit 5b057ffb, DB-only, no restart needed):
 * `bank_statement.opening_id` FK repointed from the retired `bank_opening_balance(id)` to
 * `bank_journal_entry(id)` (`NOT VALID`). `saveStatement()` now inserts cleanly — confirmed,
 * statement `bst_a0dc359826c14b3ab04e3ff92767bd00` saved on first retry.
 *
 * FIXED BLOCKER #4 (was here, now gone — commit 06df0d28, hot-reloaded, no restart needed):
 * `statement-book.ts` now selects `COALESCE(original.source_kind, e.source_kind) AS source_kind`
 * and the guard checks `row.source_kind === 'opening_balance'` instead of the always-false
 * `row.kind === 'opening_balance'`. Confirmed: `uncleared_chk_1042`'s book item now has zero
 * blockers, the match posts, and the negative journal-claim control fires as designed.
 *
 * §3 now runs end-to-end (statement save → match → negative claim). It does NOT reach
 * `difference_cents === 0`/a clean close on this fixture — see the final report for the exact,
 * expected pending amounts (this was flagged as an acceptable outcome by the task itself: "assert
 * difference 0 OR report exactly which pending items/amounts the close reports").
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { block, journalCount, record, safeCode, type Json } from "./_lib";
import { tinyPdf } from "./_pdf";

const CASE_API = process.env.CASE_API ?? "http://localhost:9096";
const CASE_DATABASE_URL =
  process.env.CASE_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa_bgl";
const LOGIN = { email: "sandbox@test.com", password: "sandbox123" };

const ACCOUNT_LIST_ID = "80000006-1317847775"; // Chase Bank Checking 7223
const EQUITY_LIST_ID = "80000005-1317847775"; // Opening Balance Equity
const INCOME_LIST_ID = "8000000B-1317847948"; // Sales (Income) — non-balance-sheet negative control
const OPENING_DAY = "2025-12-31"; // = DEFAULT_OPENING_DAY del sistema desde 2026-09-11 (antes 2026-04-13)
const OPENING_BALANCE_CENTS = 1_000_000; // $10,000.00 statement balance at cutover
const ITEM_KEY = "chk-1042";
const ITEM_AMOUNT_CENTS = 100_000; // $1,000.00 outstanding check 1042
const EXPECTED_EQUITY_CENTS = 900_000; // 1,000,000 - 100,000

interface Api {
  jwt: string;
  call(path: string, init?: { method?: string; body?: Json; headers?: Record<string, string>; allow?: number[] }): Promise<{ status: number; body: Json }>;
  get(path: string): Promise<Json>;
  post(path: string, body?: Json, headers?: Record<string, string>): Promise<Json>;
}

/** Minimal copy of `_lib.connect()`, parametrized to CASE_API/CASE_DATABASE_URL. */
async function connect18(): Promise<{ api: Api; pool: Pool }> {
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
    healthy = (await fetch(`${CASE_API}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null))?.ok === true;
    if (!healthy) await new Promise(done => setTimeout(done, 1000));
  }
  assert(healthy, `SANDBOX_BACKEND_UNAVAILABLE (${CASE_API})`);
  const auth = await fetch(`${CASE_API}/auth/user/emailpass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(LOGIN) });
  const token = record(await auth.json())?.token;
  assert(typeof token === "string", "SANDBOX_LOGIN_FAILED");
  const api: Api = {
    jwt: token,
    async call(path, init = {}) {
      const response = await fetch(`${CASE_API}${path}`, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID(), ...(init.headers ?? {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      let body: Json = {};
      try { body = record(JSON.parse(text)) ?? {}; } catch { body = { raw: text.slice(0, 300) }; }
      if (!response.ok && !(init.allow ?? []).includes(response.status)) {
        throw new Error(`HTTP_${response.status}_${safeCode(body.code)} ${init.method ?? "GET"} ${path} ${JSON.stringify(body).slice(0, 300)}`);
      }
      return { status: response.status, body };
    },
    async get(path) { return (await api.call(path)).body; },
    async post(path, body = {}, headers = {}) { return (await api.call(path, { method: "POST", body, headers })).body; },
  };
  const pool = new Pool({ connectionString: CASE_DATABASE_URL, max: 4, min: 0, idleTimeoutMillis: 15000, connectionTimeoutMillis: 10000 });
  return { api, pool };
}

async function run18(caseId: string, body: (ctx: { api: Api; pool: Pool }) => Promise<void>) {
  const ctx = await connect18();
  try { await body(ctx); console.log(`\nPASS ${caseId}`); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nFAIL ${caseId}: ${message}`);
    process.exitCode = 1;
  } finally { await ctx.pool.end(); }
}

function pdfBase64(text: string): string { return tinyPdf(text).toString("base64"); }

void run18("case-18", async ({ api, pool }) => {
  // ── §2 GL opening balance ────────────────────────────────────────────────
  const evidence = await api.post("/admin/accounting/ledger/opening-balances/evidence", {
    name: "case18OpeningEvidence", mime_type: "application/pdf", content_base64: pdfBase64("Case 18 opening evidence Chase 2025-12-31"),
  });
  const evidenceId = String(record(evidence.evidence)?.id);
  assert(evidenceId.length > 0, "opening evidence uploaded");

  const openingBody = {
    account_list_id: ACCOUNT_LIST_ID, day: OPENING_DAY, balance_cents: OPENING_BALANCE_CENTS,
    evidence_ids: [evidenceId],
    items: [{ key: ITEM_KEY, kind: "outstanding_check", original_day: "2025-12-28", amount_cents: ITEM_AMOUNT_CENTS, reference: "Check 1042", description: "outstanding at cutover" }],
  };
  const posted = await api.call("/admin/accounting/ledger/opening-balances", { method: "POST", body: openingBody, allow: [409] });
  let openingEntryId: string;
  if (posted.status === 409) {
    assert.equal(posted.body.code, "GL_ALREADY_POSTED", "409 must be the idempotent-repost code");
    openingEntryId = String(posted.body.entry_id);
  } else {
    assert.equal(posted.status, 201);
    assert.equal(posted.body.status, "posted");
    openingEntryId = String(posted.body.entry_id);
  }
  assert(openingEntryId.length > 0, "opening entry id present");

  // ── §2 verify via GET listOpeningBalances ───────────────────────────────
  const listed = await api.get("/admin/accounting/ledger/opening-balances");
  const acctEntry = (record(listed) ?? {}).accounts as Json[];
  const chase = acctEntry.find(a => record(a.account)?.qb_list_id === ACCOUNT_LIST_ID);
  assert(chase, "Chase present in opening-balances listing");
  const entry = record(chase!.entry)!;
  assert.equal(entry.id, openingEntryId);
  const lines = (entry.lines as Json[]).reduce((acc, l) => ({ ...acc, [String(l.role)]: l }), {} as Record<string, Json>);
  assert.equal(lines.opening?.debit_cents, "1000000"); assert.equal(lines.opening?.credit_cents, "0"); assert.equal(lines.opening?.account_list_id, ACCOUNT_LIST_ID);
  assert.equal(lines.uncleared_chk_1042?.debit_cents, "0"); assert.equal(lines.uncleared_chk_1042?.credit_cents, "100000"); assert.equal(lines.uncleared_chk_1042?.account_list_id, ACCOUNT_LIST_ID);
  assert.equal(lines.equity?.debit_cents, "0"); assert.equal(lines.equity?.credit_cents, String(EXPECTED_EQUITY_CENTS)); assert.equal(lines.equity?.account_list_id, EQUITY_LIST_ID);

  // ── §2 trial balance: Chase closing must equal Σ(debit-credit) over ALL active lines on the account ──
  const trial = await api.get(`/admin/accounting/ledger/trial-balance?from=${OPENING_DAY}&to=2026-09-30&include_zero=true`);
  const trialRow = ((record(trial) ?? {}).accounts as Json[]).find(r => r.list_id === ACCOUNT_LIST_ID);
  assert(trialRow, "Chase row present in trial balance");
  const expected = (await pool.query<{ closing: string }>(
    `SELECT (COALESCE(SUM(l.debit_cents),0)-COALESCE(SUM(l.credit_cents),0))::text AS closing
     FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
     WHERE l.account_list_id=$1 AND l.deleted_at IS NULL AND e.deleted_at IS NULL AND e.day<=$2
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id AND r.deleted_at IS NULL)`,
    [ACCOUNT_LIST_ID, "2026-09-30"]
  )).rows[0]!.closing;
  assert.equal(String(trialRow!.closing_cents), String(BigInt(expected)), "trial-balance closing == SQL Σ(debit-credit)");

  // ── §4 negative controls ─────────────────────────────────────────────────
  const dup = await api.call("/admin/accounting/ledger/opening-balances", { method: "POST", body: openingBody, allow: [409] });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, "GL_ALREADY_POSTED");

  const badAccount = await api.call("/admin/accounting/ledger/opening-balances", { method: "POST", allow: [400],
    body: { account_list_id: INCOME_LIST_ID, day: OPENING_DAY, balance_cents: 100, evidence_ids: [evidenceId], items: [] } });
  assert.equal(badAccount.status, 400); assert.equal(badAccount.body.code, "GL_SOURCE_INVALID");

  // ── §5 journal count: exactly ONE active bank_journal_entry document for this OBE ──
  const activeOpenings = await journalCount(pool,
    "source_kind='opening_balance' AND source_id=$1 AND kind='document' AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=bank_journal_entry.id AND r.deleted_at IS NULL)",
    [ACCOUNT_LIST_ID]);
  assert.equal(activeOpenings, 1, "exactly one active opening_balance document for Chase");

  // ── §1 feed via /admin/banking/transactions ─────────────────────────────
  const overview = record(await api.get("/admin/banking"))!;
  assert.equal(record(overview.config)?.environment, "sandbox", "BANKING_NOT_SANDBOX");
  const baseAccountRow = (overview.accounts as Json[]).find(a => a.name === "EPT Sandbox checking" && a.mask === "0042");
  assert(baseAccountRow, "base account 'EPT Sandbox checking' ···0042 present");
  assert.equal(baseAccountRow!.qb_list_id, ACCOUNT_LIST_ID);
  const baseAccountId = String(baseAccountRow!.id);
  const feed = record(await api.get(`/admin/banking/transactions?account_id=${baseAccountId}&limit=100&offset=0&history=true`))!;
  const feedTx = feed.transactions as Json[];
  const chk1042 = feedTx.find(t => t.id === "btxn_review_case13_chk1042");
  const chk1043 = feedTx.find(t => t.id === "btxn_review_case13_chk1043");
  assert(chk1042 && chk1043, "both CHECK 1042/1043 feed rows present");
  assert.equal(chk1042!.status, "posted"); assert.equal(chk1042!.date, "2026-09-05"); assert.equal(Number(chk1042!.amount), -1000, "CHECK 1042 = $1,000.00 money out");
  assert.equal(chk1043!.status, "posted"); assert.equal(chk1043!.date, "2026-09-05"); assert.equal(Number(chk1043!.amount), -999.99, "CHECK 1043 = $999.99 money out");

  // ── §3 statement flow ────────────────────────────────────────────────────
  // `to`=2026-09-30 (as specified) is REJECTED (BANKING_STATEMENT_DATE_INVALID: `to > reviewToday()`,
  // and reviewToday() is the real wall-clock business date — 2026-09-10 today). Using 2026-09-10
  // instead; still covers every Sept feed row (09-02/09-03/09-05/09-05).
  const STATEMENT_FROM = "2026-09-01", STATEMENT_TO = "2026-09-10";
  const statementLineDefs = feedTx
    .filter(t => typeof t.date === "string" && t.date >= STATEMENT_FROM && t.date <= STATEMENT_TO && t.status === "posted")
    .map(t => ({ external_key: String(t.id), day: String(t.date), amount_cents: Math.round(Number(t.amount) * 100), description: String(t.name), transaction_id: String(t.id) }));
  assert(statementLineDefs.some(l => l.transaction_id === "btxn_review_case13_chk1042"), "CHECK 1042 is one of the statement lines");
  const credit = statementLineDefs.reduce((s, l) => s + Math.max(l.amount_cents, 0), 0);
  const debit = statementLineDefs.reduce((s, l) => s + Math.max(-l.amount_cents, 0), 0);
  const closingCents = OPENING_BALANCE_CENTS + credit - debit;

  const existingStatement = (await pool.query<{ id: string; revision: number; status: string }>(
    `SELECT id, revision, status FROM bank_statement WHERE account_list_id=$1 AND from_day=$2 AND to_day=$3 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [ACCOUNT_LIST_ID, STATEMENT_FROM, STATEMENT_TO]
  )).rows[0];

  let statementId: string | null = existingStatement?.id ?? null;
  let statementBlocked: { status: number; code: string } | null = null;
  let matchResult: { status: number; code?: string } | null = null;
  let claimNegative: { status: number; code?: string } | null = null;
  let closeResult: { status: number; body: Json } | null = null;

  if (!statementId) {
    const stmtEvidence = await api.post("/admin/banking/evidence", { name: "case18StatementEvidence", mime_type: "application/pdf", content_base64: pdfBase64("Case 18 statement evidence Chase September") });
    const stmtEvidenceId = String(record(stmtEvidence.evidence)?.id);
    const statementBody = {
      expected_revision: 0, bank_account_id: baseAccountId, from: STATEMENT_FROM, to: STATEMENT_TO,
      reference: "Case18 September statement Chase", evidence_id: stmtEvidenceId,
      opening_balance_cents: OPENING_BALANCE_CENTS, closing_balance_cents: closingCents,
      declared_line_count: statementLineDefs.length, declared_credits_cents: credit, declared_debits_cents: debit,
      completeness_attested: true, lines: statementLineDefs,
    };
    const saved = await api.call("/admin/banking/statements", { method: "POST", body: statementBody, allow: [409] });
    if (saved.status === 409 && saved.body.code === "BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED") {
      // The known open blocker documented in the file header — assert it precisely instead of
      // silently treating a 409 as "expected close difference".
      statementBlocked = { status: saved.status, code: String(saved.body.code) };
    } else {
      assert.equal(saved.status, 200, `unexpected statement-save response: ${JSON.stringify(saved.body)}`);
      const savedStatement = record(record(saved.body)!.statement)!;
      statementId = String(savedStatement.id);
    }
  }

  let closingSnapshot: Json | null = null;
  if (statementId) {
    // ── match CHECK 1042 against the GL uncleared_chk_1042 line ───────────
    let ctx = record(await api.get(`/admin/banking/statements/${statementId}`))!;
    const line1042 = (ctx.lines as Json[]).find(l => l.transaction_id === "btxn_review_case13_chk1042")!;
    const uncleared = (await pool.query<{ id: string }>(`SELECT id FROM bank_journal_line WHERE entry_id=$1 AND role='uncleared_chk_1042'`, [openingEntryId])).rows[0]!;
    const bookItem = (ctx.book_items as Json[]).find(b => b.id === uncleared.id)!;
    const hasMatch = (ctx.matches as Json[]).some(m => m.book_id === uncleared.id && m.statement_line_id === line1042.id);
    if (!hasMatch) {
      const matched = await api.call(`/admin/banking/statements/${statementId}/matches`, { method: "POST",
        body: { expected_revision: Number(ctx.statement.revision), allocations: [{ statement_line_id: line1042.id, book_kind: "journal_line", book_id: uncleared.id, amount_cents: ITEM_AMOUNT_CENTS, expected_book_hash: bookItem.source_hash }] } });
      matchResult = { status: 200 };
      void matched;
    } else { matchResult = { status: 200 }; }
    ctx = record(await api.get(`/admin/banking/statements/${statementId}`))!;

    // ── negative journal-claim check: a direct expense on the claimed CHECK 1042 must be rejected ──
    const claim = await api.call(`/admin/banking/accounting/transactions/btxn_review_case13_chk1042`, { method: "POST", allow: [409],
      body: { expected_revision: 0, source_hash: "a".repeat(64), nature: "new_direct_expense", reference: "case18-negative-claim", description: "must be rejected: transaction cleared by GL statement match", attested: true, dismissals: [] } });
    claimNegative = { status: claim.status, code: String(claim.body.code) };
    assert.equal(claim.status, 409, "a claimed transaction cannot become a direct expense");
    assert.equal(claim.body.code, "BANKING_OPENING_TRANSACTION_CLAIMED");

    // ── attempt close: assert difference 0 OR report exactly what's pending ──
    const preview = await api.call(`/admin/banking/statements/${statementId}/preview`, { method: "POST", allow: [409], body: { expected_revision: Number(ctx.statement.revision) } });
    if (preview.status === 200) {
      const close = await api.call(`/admin/banking/statements/${statementId}/close`, { method: "POST", allow: [409],
        body: { expected_revision: Number(ctx.statement.revision), preview_hash: preview.body.preview_hash } });
      closeResult = close;
    } else {
      closeResult = preview;
    }
    closingSnapshot = { blockers: ctx.blockers, difference_cents: ctx.difference_cents, book_balance_cents: ctx.book_balance_cents,
      lines: (ctx.lines as Json[]).map(l => ({ id: l.id, transaction_id: l.transaction_id, amount_cents: l.amount_cents, remaining_cents: l.remaining_cents })) };
  }

  block("Qué hice", {
    opening_evidence_id: evidenceId, opening_entry_id: openingEntryId, opening_request: openingBody,
    negative_controls_gl: ["same body again → 409 GL_ALREADY_POSTED", `account_list_id=${INCOME_LIST_ID} (Income) → 400 GL_SOURCE_INVALID`],
    feed_verified: { chk1042: { id: chk1042!.id, amount: chk1042!.amount, date: chk1042!.date }, chk1043: { id: chk1043!.id, amount: chk1043!.amount, date: chk1043!.date } },
    statement_request: statementBlocked ? "BLOCKED before save — see statement_blocked below" : { from: STATEMENT_FROM, to: STATEMENT_TO, lines: statementLineDefs.length, closing_balance_cents: closingCents },
    negative_control_journal_claim: claimNegative,
  });
  block("Qué esperamos", {
    opening_balance: { entry_id: openingEntryId, lines: { opening: lines.opening, uncleared_chk_1042: lines.uncleared_chk_1042, equity: lines.equity } },
    trial_balance_chase: { api_closing_cents: trialRow!.closing_cents, sql_expected_closing_cents: expected, equal: true },
    negative_controls_gl: { duplicate_post: { status: dup.status, code: dup.body.code }, non_balance_sheet: { status: badAccount.status, code: badAccount.body.code } },
    journal_count_active_openings_chase: activeOpenings,
    statement_blocked: statementBlocked,
    statement_id: statementId,
    match_result: matchResult,
    negative_control_journal_claim: claimNegative,
    close_attempt: closeResult ? { status: closeResult.status, body: closeResult.body } : null,
    closing_snapshot: closingSnapshot,
  });
  block("Mirá", statementBlocked
    ? "GL opening balance: OK en http://localhost:3099 (Accounting → Ledger). El statement de Septiembre de Chase NO se pudo guardar — cualquier POST a /admin/banking/statements para esta cuenta devuelve 409 BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED por el bug documentado en el header del archivo (statement-source.ts:45-49, una reversal vieja de OTRA sesión sigue matcheando role='opening')."
    : "http://localhost:3099/accounting/banks/statements → Chase, Septiembre 2026-09-01..2026-09-10; línea CHECK 1042 matcheada contra la línea GL uncleared_chk_1042; intentar un direct expense sobre esa misma transacción se rechaza (BANKING_OPENING_TRANSACTION_CLAIMED).");
});
