/** V6: real receipts are read-only; only this harness's banking fixtures are mutable. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Browser, Page } from "../../../../web/node_modules/playwright-core";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import type { MatchCandidate } from "../../lib/banking/review-matching";
import { MATCH_RANK_FIELDS_SQL } from "../../lib/banking/review-matching";
import type { MatchSuggestion } from "../../lib/banking/review-match-suggestions";

type Value = Record<string, unknown>;
type Receipt = { id: string; amount: string; currency: string; reference: string; customer_id: string;
  customer_name: string; matching_count: number; has_invoice: boolean };
const connection = "bconn_e2e_bank_matches"; const account = "bacc_e2e_bank_matches";
const day = "2026-08-20"; const prefix = "btx_e2e_matches_";
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;
let checks = 0;
function truth(value: unknown, label: string): asserts value { assert.ok(value, label); checks++; }
const same = (a: unknown, b: unknown, label: string) => truth(JSON.stringify(a) === JSON.stringify(b), label);
function record(value: unknown): Value { assert(value && typeof value === "object" && !Array.isArray(value)); return value as Value; }
async function fingerprint(client: PoolClient) {
  const rows: Record<string, unknown> = {};
  for (const table of financialTables) rows[table] = (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash FROM ${table} t`)).rows[0];
  return rows;
}
async function clean(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(`DELETE FROM bank_review_event WHERE transaction_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)
      OR entity_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)`, [connection]);
    for (const table of ["bank_review_attachment", "bank_transaction_review"]) await client.query(
      `DELETE FROM ${table} WHERE transaction_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)`, [connection]);
    for (const table of ["bank_webhook_event", "bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
  });
}

async function main() {
  configureBankSandbox(); process.env.POS_URL = "http://localhost:3099"; process.env.MEDUSA_SANDBOX_URL = "http://localhost:9099";
  const pool = getDbPool(); const client = await pool.connect();
  let before: Record<string, unknown> | undefined; let owns = false; let jwt = "";
  let browser: Browser | undefined; let page: Page | undefined;
  const payloads: string[] = []; const samples: { selector: string; bytes: number; milliseconds: number }[] = [];
  const api = async (path: string, body?: Value, status = 200, anonymous = false) => {
    const started = performance.now();
    const response = await fetch(`http://localhost:9099${path}`, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(!anonymous && jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(body ? { "Idempotency-Key": randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    const text = await response.text(); const result = record(JSON.parse(text));
    truth(response.status === status, `HTTP ${path.split("?")[0]} expected ${status}; received ${response.status}; code ${String(result.code ?? "none")}`);
    if (!body && response.ok && /match-suggestions|match-candidates/.test(path)) {
      payloads.push(text); samples.push({ selector: path.includes("?date=") ? "day" : path.includes("match-candidates") ? "candidates" : "batch",
        bytes: Buffer.byteLength(text), milliseconds: Math.round(performance.now() - started) });
    }
    return result;
  };
  const suggestions = async (ids: string[]) => (await api(`/admin/banking/match-suggestions?ids=${ids.join(",")}`)).suggestions as MatchSuggestion[];
  const candidates = async (id: string) => (await api(`/admin/banking/transactions/${id}/match-candidates?q=`)).candidates as MatchCandidate[];
  const review = async (id: string) => (await client.query("SELECT id,revision,source_version,mode,matched_payment_id,counterparty_id,status FROM bank_transaction_review WHERE transaction_id=$1", [id])).rows[0] as Value | undefined;
  const versions = async (id: string) => ({ expected_revision: (await review(id))?.revision ?? 0, expected_source_version: 1 });
  const clear = async (id: string) => api(`/admin/banking/transactions/${id}/return`, await versions(id));
  try {
    const emitted = createRequire(resolve(__dirname, "../../../package.json"));
    truth(typeof emitted(resolve(__dirname, "../../../.medusa/server/src/api/admin/banking/match-suggestions/route.js")).GET === "function",
      "Built suggestions route loads with its runtime dependencies");
    truth(typeof emitted(resolve(__dirname, "../../../.medusa/server/src/lib/banking/review-matching.js")).matchCandidates === "function",
      "Built matching helper loads with its runtime dependencies");
    owns = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-matches-fixtures',7241)) AS locked")).rows[0].locked === true;
    truth(owns, "Another matching harness must not be disturbed"); before = await fingerprint(client); await clean(client);
    truth(!(await client.query("SELECT 1 FROM bank_day_close WHERE day=$1 AND status='closed' AND deleted_at IS NULL", [day])).rowCount, "Fixture day must be open");
    for (const [reference, bankName, expected] of [["ABC-1234", "paid ABC-1234 today", true], ["ABC-1234", "paid ABC 1234 today", true],
      ["ABC-1234", "paid ABC-12345 today", false], ["ABC1234", "paid XABC1234 today", false], ["123", "paid 123 today", false]] as const) {
      const ranked = (await client.query(`SELECT ${MATCH_RANK_FIELDS_SQL} FROM
        (SELECT $1::text AS reference,'2026-08-18T12:00:00Z'::timestamptz AS received_at) mp CROSS JOIN
        (SELECT $2::text AS name,NULL::text AS merchant_name,'2026-08-20'::date AS transaction_date) t`, [reference, bankName])).rows[0];
      truth(ranked.reference_match === expected && ranked.date_distance === 2, "Real ranking SQL preserves phrase boundaries and bank/payment dates");
    }
    const control = (await client.query<{ unique: Receipt | null; repeated: Receipt | null; invoice: Receipt | null }>(`WITH eligible AS (
      SELECT p.id,(-p.amount::numeric/100)::text AS amount,upper(p.currency) AS currency,p.customer_id,
        COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
        COALESCE(p.reference,'') AS reference,
        count(*) OVER(PARTITION BY p.amount::numeric,upper(p.currency))::int AS matching_count,
        EXISTS(SELECT 1 FROM payment_application pa JOIN pos_invoice i ON i.id=pa.invoice_id
          WHERE pa.payment_id=p.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL AND pa.amount_applied::numeric>0
            AND i.customer_id=p.customer_id AND i.deleted_at IS NULL AND i.status NOT IN('draft','voided')) AS has_invoice
      FROM customer_payment p JOIN customer c ON c.id=p.customer_id AND c.deleted_at IS NULL
      WHERE p.type='payment' AND p.method IN('ach','zelle','check') AND p.status IN('available','partially_applied','applied')
        AND p.amount::numeric>0 AND upper(p.currency)='USD' AND p.deleted_at IS NULL AND COALESCE(p.metadata->>'qb_import','false')='false'
        AND NOT EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.matched_payment_id=p.id AND r.status<>'excluded' AND r.deleted_at IS NULL))
      SELECT (SELECT to_jsonb(e) FROM eligible e WHERE matching_count=1 ORDER BY has_invoice DESC,id LIMIT 1) AS unique,
        (SELECT to_jsonb(e) FROM eligible e WHERE matching_count>1 AND length(regexp_replace(reference,'[^A-Za-z0-9]','','g'))>=4 ORDER BY has_invoice DESC,id LIMIT 1) AS repeated,
        (SELECT to_jsonb(e) FROM eligible e WHERE has_invoice AND matching_count<=50 ORDER BY matching_count,id LIMIT 1) AS invoice`)).rows[0]!;
    truth(control.unique, "A unique-amount existing monetary receipt is required");
    const unique = control.unique;
    const rows: { id: string; amount: string; name: string; pending?: boolean }[] = [
      { id: `${prefix}unique`, amount: unique.amount, name: "EPT match unique deposit" },
      { id: `${prefix}duplicate`, amount: unique.amount, name: "EPT match second deposit" },
      { id: `${prefix}outflow`, amount: unique.amount.slice(1), name: "EPT match outgoing control" },
      { id: `${prefix}pending`, amount: unique.amount, name: "EPT match pending control", pending: true },
    ];
    if (control.repeated) rows.push({ id: `${prefix}reference`, amount: control.repeated.amount, name: control.repeated.reference },
      { id: `${prefix}boundary`, amount: control.repeated.amount, name: `EPTBOUNDARYX${control.repeated.reference.replace(/[^A-Za-z0-9]/g, "")}Y` });
    if (control.invoice) rows.push({ id: `${prefix}invoice`, amount: control.invoice.amount, name: "EPT match invoice context" });
    await transaction(client, async () => {
      await withReviewLock(client);
      const cap = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS connections,
        (SELECT count(*) FROM bank_account)::int AS accounts,(SELECT count(*) FROM bank_transaction)::int AS transactions`)).rows[0];
      truth(cap.connections < 3 && cap.accounts < 10 && cap.transactions + rows.length <= 2000, "Fixture respects banking caps");
      await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete,last_successful_sync_at)
        VALUES($1,'plaid','sandbox',$1,'disconnected',true,true,now())`, [connection]);
      await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,
        review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
        VALUES($1,$2,$1,'EPT match harness account','depository','USD',true,'2026-08-01','0','2026-07-31','Synthetic fixture only',1)`, [account, connection]);
      for (const row of rows) await client.query(`INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,
        amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$1,$4,'USD',$5,$6,$7,'{}'::jsonb,now(),now())`,
      [row.id, connection, account, row.amount, row.pending ? "pending" : "posted", day, row.name]);
    });
    const first = rows[0]!.id; const second = rows[1]!.id;
    await api(`/admin/banking/match-suggestions?ids=${first}`, undefined, 401, true);
    jwt = String((await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" })).token);
    truth(jwt && jwt !== "undefined", "Dedicated sandbox administrator authenticated");
    for (const selector of ["", `?ids=${first}&date=${day}`, "?date=2026-02-30", "?ids=", `?ids=${first},${first}`,
      `?ids=${Array.from({ length: 101 }, (_, i) => `overflow_${i}`).join(",")}`]) await api(`/admin/banking/match-suggestions${selector}`, undefined, 400);
    const bankBeforeGets = (await client.query("SELECT count(*)::int AS n FROM bank_review_event")).rows[0].n;
    const batch = await suggestions(rows.map(row => row.id));
    const one = batch.find(item => item.transaction_id === first)!;
    truth(one?.candidate_count === 1 && !one.ambiguous && one.best?.id === unique.id, "Unique receipt is suggested without changing source data");
    truth(batch.some(item => item.transaction_id === second && item.best?.id === unique.id), "One batch finds candidates for multiple deposits");
    truth(!batch.some(item => item.transaction_id.endsWith("outflow") || item.transaction_id.endsWith("pending")), "Unsupported outgoing and pending movements get no automatic hints");
    for (const unsupported of rows.slice(2, 4)) {
      const result = await api(`/admin/banking/transactions/${unsupported.id}/match-candidates?q=`);
      truth(result.supported === false && (result.candidates as unknown[]).length === 0, "Unsupported source has no picker candidates");
    }
    await transaction(client, async () => { await withReviewLock(client); await client.query("UPDATE bank_account SET type='credit' WHERE id=$1", [account]); });
    truth((await suggestions([first])).length === 0, "Credit-card account does not offer receipt matches");
    await transaction(client, async () => { await withReviewLock(client); await client.query("UPDATE bank_account SET type='depository' WHERE id=$1", [account]); });
    if (control.repeated) {
      const exact = batch.find(item => item.transaction_id === `${prefix}reference`)!;
      const boundary = batch.find(item => item.transaction_id === `${prefix}boundary`)!;
      truth(exact.ambiguous && exact.candidate_count === control.repeated.matching_count, "Repeated real amount remains explicitly ambiguous");
      truth(exact.best && exact.reason.includes("reference matches"), "Exact reference phrase ranks ahead of unmatched references");
      truth(!boundary.reason.includes("reference matches"), "Embedding reference inside a larger token cannot create an exact match");
      truth((await candidates(`${prefix}reference`))[0]?.id === exact.best?.id, "Picker and batch apply identical reference ranking");
    }
    if (control.invoice) {
      const context = (await candidates(`${prefix}invoice`)).find(item => item.id === control.invoice!.id)!;
      truth(context && context.invoices.length > 0, "Existing applied receipt exposes real invoice context");
      truth(new Set(context.invoices.map(invoice => invoice.id)).size === context.invoices.length, "Invoice applications cannot duplicate candidate invoices");
      const expected = (await client.query(`SELECT i.id,i.invoice_number AS number,i.status,(SUM(pa.amount_applied::numeric)/100)::text AS applied_amount
        FROM payment_application pa JOIN pos_invoice i ON i.id=pa.invoice_id WHERE pa.payment_id=$1 AND pa.deleted_at IS NULL
        AND pa.voided_at IS NULL AND pa.amount_applied::numeric>0 AND i.deleted_at IS NULL AND i.customer_id=$2
        AND i.status NOT IN('draft','voided') GROUP BY i.id,i.invoice_number,i.status ORDER BY i.invoice_number,i.id`, [control.invoice.id, control.invoice.customer_id])).rows;
      same(context.invoices.map(({ id, number, status, applied_amount }) => ({ id, number, status, applied_amount })), expected, "Invoice context equals current read-only applications in major units");
    }
    const daily = (await api(`/admin/banking/match-suggestions?date=${day}`)).suggestions as MatchSuggestion[];
    truth(daily.some(item => item.transaction_id === first && item.best?.id === unique.id), "Daily selector includes the same suggestion");
    truth((await client.query("SELECT count(*)::int AS n FROM bank_review_event")).rows[0].n === bankBeforeGets && !(await review(first)), "Suggestion GETs create neither reviews nor audit events");
    const candidate = (await candidates(first))[0]!;
    const matchBody = { ...await versions(first), mode: "match", matched_payment_id: candidate.id, comment: "Matching fixture" };
    const missing = await api(`/admin/banking/transactions/${first}/review`, matchBody, 400);
    truth(missing.code === "BANKING_MATCH_SOURCE_HASH_REQUIRED", "Selecting a receipt requires its displayed source hash");
    const wrong = candidate.source_hash === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
    const stale = await api(`/admin/banking/transactions/${first}/review`, { ...matchBody, expected_match_source_hash: wrong }, 409);
    truth(stale.code === "BANKING_MATCH_STALE" && !(await review(first)), "Forged source hash is rejected without persisting a decision");
    truth((await client.query("SELECT count(*)::int AS n FROM bank_review_event")).rows[0].n === bankBeforeGets, "Rejected match commands persist no audit or command receipts");
    const selected = record((await api(`/admin/banking/transactions/${first}/review`, { ...matchBody, expected_match_source_hash: candidate.source_hash })).review);
    truth(selected.matched_payment_id === unique.id && selected.counterparty_id === unique.customer_id && selected.status === "draft", "Explicit selection persists customer and match as draft");
    const duplicate = await api(`/admin/banking/transactions/${second}/review`, { ...matchBody, expected_match_source_hash: candidate.source_hash }, 409);
    truth(duplicate.code === "BANKING_MATCH_INVALID_OR_RESERVED" && !(await review(second)), "Second deposit cannot reserve the same receipt");
    await clear(first);
    const harness = await import(pathToFileURL(resolve(__dirname, "../../../../store-pos/scripts/e2e/_harness.mjs")).href) as {
      launch(): Promise<Browser>; login(page: Page): Promise<void> };
    browser = await harness.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const responseReads: Promise<void>[] = [];
    page.on("response", response => {
      if (!response.ok() || response.request().method() !== "GET" || !/match-suggestions|match-candidates/.test(response.url())) return;
      responseReads.push((async () => { const text = await response.text(); payloads.push(text);
        samples.push({ selector: response.url().includes("match-candidates") ? "browser_candidates" : "browser_batch",
          bytes: Buffer.byteLength(text), milliseconds: Math.round(response.request().timing().responseEnd) }); })());
    });
    let external = 0; let providerRequests = 0;
    await page.route("**/*", route => { const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname)) {
        external++; if (/plaid|authorize|bams/i.test(url.hostname)) providerRequests++; return route.abort(); }
      return route.continue(); });
    await harness.login(page); await page.goto("http://localhost:3099/accounting/banks", { waitUntil: "domcontentloaded" });
    await page.locator(`[data-bank-account-id="${account}"]`).click();
    await page.locator(`[data-bank-match-id="${first}"]`).click();
    const bankSelected = page.waitForResponse(response => response.url().endsWith(`/transactions/${first}/review`) && response.request().method() === "POST");
    await page.locator(`[data-bank-match-payment-id="${unique.id}"]`).click();
    truth((await bankSelected).ok(), "Banks automatic hint permits explicit receipt selection");
    truth((await review(first))?.counterparty_id === unique.customer_id, "Banks selection fills the real customer");
    await page.waitForFunction(({ name, customer }) => [...document.querySelectorAll('input')].some(input =>
      input.getAttribute('aria-label') === `From / To for ${name}` && input.value === customer), { name: rows[0]!.name, customer: unique.customer_name });
    await page.waitForFunction(name => [...document.querySelectorAll('input')].some(input => input.getAttribute('aria-label') === `Match / Category for ${name}` && /^Receipt \d+$/.test(input.value) && input.getAttribute('aria-expanded') === 'false'), rows[0]!.name);
    mkdirSync("/tmp/ept-bank-feed-sandbox", { recursive: true }); await page.screenshot({ path: "/tmp/ept-bank-feed-sandbox/banks-match-suggestion.png", fullPage: true });
    await clear(first);
    await page.goto(`http://localhost:3099/accounting/banks/daily-close?date=${day}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-bank-match-id="${second}"]`).click();
    const dailySelected = page.waitForResponse(response => response.url().endsWith(`/transactions/${second}/review`) && response.request().method() === "POST");
    await page.locator(`[data-bank-match-payment-id="${unique.id}"]`).click();
    truth((await dailySelected).ok() && (await review(second))?.counterparty_id === unique.customer_id, "Daily open view offers the same explicit Match selection");
    await page.waitForFunction(({ name, customer }) => [...document.querySelectorAll('input')].some(input =>
      input.getAttribute('aria-label') === `From / To for ${name}` && input.value === customer), { name: rows[1]!.name, customer: unique.customer_name });
    await page.waitForFunction(name => [...document.querySelectorAll('input')].some(input => input.getAttribute('aria-label') === `Match / Category for ${name}` && /^Receipt \d+$/.test(input.value) && input.getAttribute('aria-expanded') === 'false'), rows[1]!.name);
    await page.screenshot({ path: "/tmp/ept-bank-feed-sandbox/banks-daily-match-suggestion.png", fullPage: true });
    truth(providerRequests === 0, "Browser attempted no external financial-provider requests");
    await Promise.all(responseReads);
    const totalBytes = payloads.reduce((n, text) => n + Buffer.byteLength(text), 0);
    truth(totalBytes <= 1024 * 1024, "Total actual matching GET payloads fit the 1 MiB verification budget");
    console.log(JSON.stringify({ measurement: "match_suggestions_http", requests: samples.length, bytes: totalBytes,
      gzip_bytes: gzipSync(payloads.join("")).length, blocked_external_resources: external, samples,
      coverage: { unique: true, ambiguous_reference: Boolean(control.repeated), invoice_context: Boolean(control.invoice), browser_banks: true, browser_daily: true } }));
  } catch (error) {
    if (page) { mkdirSync("/tmp/ept-bank-feed-sandbox", { recursive: true }); await page.screenshot({ path: "/tmp/ept-bank-feed-sandbox/banks-match-failure.png", fullPage: true }).catch(() => {}); }
    console.log(`Completed ${checks} matching assertions before failure; cleanup follows.`); throw error;
  } finally {
    try { await browser?.close(); if (owns) { await clean(client); if (before) same(await fingerprint(client), before, "All eight financial fingerprints unchanged");
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-matches-fixtures',7241))"); } }
    finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank matches: ${checks} checks; own banking fixtures removed; financial evidence unchanged`);
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "BANK_MATCH_E2E_FAILED"); process.exitCode = 1; });
