/** Real authenticated HTTP checks against the sandbox backend, with isolated banking fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { PoolClient } from "pg";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { getDbPool } from "../../api/utils/db-pool";
import { transaction } from "../../lib/banking/store";
import { withReviewLock, reviewHash } from "../../lib/banking/review-common";

type Value = Record<string, unknown>;
type Permission = { id: string; user_id: string; can_review: boolean; can_close: boolean; granted_by: string;
  created_at: string; updated_at: string; deleted_at: string | null };
const connection = "bconn_verify_review_http";
const account = "bacc_verify_review_http";
const tx = "btx_verify_review_http";
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;
const entityIds = [account, tx];
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); assertions++; }
function truth(value: unknown, label: string) { assert.ok(value, label); assertions++; }
function record(value: unknown): Value { assert(value && typeof value === "object" && !Array.isArray(value)); return value as Value; }
async function fingerprints(client: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of financialTables) result[table] = (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash FROM ${table} t`)).rows[0];
  return result;
}
async function clean(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(`DELETE FROM bank_review_event WHERE transaction_id=$1 OR entity_id=ANY($2::text[])
      OR entity_id IN(SELECT id FROM bank_review_attachment WHERE transaction_id=$1)
      OR entity_id IN(SELECT id FROM bank_transaction_review WHERE transaction_id=$1)`, [tx, entityIds]);
    await client.query("DELETE FROM bank_review_attachment WHERE transaction_id=$1", [tx]);
    await client.query("DELETE FROM bank_transaction_review WHERE transaction_id=$1", [tx]);
    for (const table of ["bank_webhook_event", "bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
  });
}

type OpeningSetup = { id: string; review_start_date: string | null; opening_bank_balance: string | null;
  opening_balance_date: string | null; opening_reference: string | null; opening_book_balance: string | null; setup_revision: number };
const setupColumns = "id,review_start_date,opening_bank_balance,opening_balance_date,opening_reference,opening_book_balance,setup_revision";
async function browserWithSetupRestore(client: PoolClient) {
  const original = (await client.query<OpeningSetup>(`SELECT ${setupColumns} FROM bank_account
    WHERE name='EPT Sandbox checking' AND deleted_at IS NULL`)).rows;
  equal(original.length, 1, "Exactly one session-owned provider fixture is available for browser verification");
  const previous = original[0]!;
  const workspace = resolve(__dirname, "../../../..");
  try {
    execFileSync(process.execPath, [resolve(workspace, "store-pos/scripts/e2e/bank-review.mjs")],
      { cwd: resolve(workspace, "store-pos"), stdio: "inherit", timeout: 240000 });
  } finally {
    await transaction(client, async () => {
      await withReviewLock(client);
      const current = (await client.query<OpeningSetup>(`SELECT ${setupColumns} FROM bank_account WHERE id=$1 FOR UPDATE`, [previous.id])).rows[0];
      if (current?.setup_revision === previous.setup_revision) {
        equal(current, previous, "Browser preserved existing operator setup"); return;
      }
      truth(previous.review_start_date === null, "Do not overwrite an existing setup modified concurrently");
      const restored = await client.query(`UPDATE bank_account SET review_start_date=$2,opening_bank_balance=$3,
        opening_balance_date=$4,opening_reference=$5,opening_book_balance=$6,setup_revision=$7,updated_at=now()
        WHERE id=$1 AND setup_revision=$8 AND review_start_date='2026-09-01'
          AND opening_bank_balance::numeric=1000 AND opening_balance_date='2026-08-31'
          AND opening_reference=$9 AND opening_book_balance IS NULL
          AND NOT EXISTS(SELECT 1 FROM bank_day_close d WHERE d.status='closed' AND d.deleted_at IS NULL
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d.snapshot->'accounts','[]'::jsonb)) b WHERE b->'account'->>'id'=$1))`,
      [previous.id, previous.review_start_date, previous.opening_bank_balance, previous.opening_balance_date,
        previous.opening_reference, previous.opening_book_balance, previous.setup_revision, previous.setup_revision + 1,
        "EPT simulated statement 2026-08-31 — UI test"]);
      equal(restored.rowCount, 1, "Restore only this browser's synthetic opening setup with exact CAS");
    });
  }
}

async function main() {
  configureBankSandbox();
  const pool = getDbPool(); const client = await pool.connect();
  let jwt = ""; let before: Record<string, unknown> | undefined; let owns = false;
  let permissionUser = ""; let originalPermission: Permission | undefined;
  const permissionKeys: string[] = [];
  const lookupMeasurements: { path: string; bytes: number; elapsed_ms: number; count: unknown; text: string }[] = [];
  async function api(path: string, body?: Value, options: { status?: number; key?: string; anonymous?: boolean } = {}) {
    const started = performance.now();
    const response = await fetch(`http://localhost:9099${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json",
        ...(!options.anonymous && jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(options.key !== "" ? { "Idempotency-Key": options.key ?? randomUUID() } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text(); const result = record(JSON.parse(text));
    if (path.startsWith("/admin/banking/lookups/")) lookupMeasurements.push({ path,
      bytes: Buffer.byteLength(text), elapsed_ms: Math.round(performance.now() - started), count: result.count, text });
    equal(response.status, options.status ?? 200, `HTTP ${path}: ${String(result.code ?? "ok")}`);
    return result;
  }
  async function restorePermission() {
    if (!permissionKeys.length) return;
    await transaction(client, async () => {
      await withReviewLock(client);
      const receipts = (await client.query<{ id: string; created_at: string; result: { permission: Permission } }>(
        `SELECT id,created_at::text,result FROM bank_review_event WHERE idempotency_key=ANY($1::text[]) ORDER BY created_at DESC,id DESC`,
        [permissionKeys])).rows;
      const last = receipts[0]; if (!last) return;
      const expected = last.result.permission;
      const values = [expected.id, permissionUser, expected.can_review, expected.can_close, last.created_at];
      const cas = "id=$1 AND user_id=$2 AND granted_by=$2 AND can_review=$3 AND can_close=$4 AND updated_at=$5::timestamptz AND deleted_at IS NULL";
      const restored = originalPermission ? await client.query(`UPDATE bank_review_permission SET can_review=$6,
        can_close=$7,granted_by=$8,created_at=$9::timestamptz,updated_at=$10::timestamptz,deleted_at=$11::timestamptz
        WHERE ${cas}`, [...values, originalPermission.can_review, originalPermission.can_close, originalPermission.granted_by,
        originalPermission.created_at, originalPermission.updated_at, originalPermission.deleted_at])
        : await client.query(`DELETE FROM bank_review_permission WHERE ${cas}`, values);
      equal(restored.rowCount, 1, "Only the dedicated admin permission fixture is restored with CAS");
      await client.query(`DELETE FROM bank_review_event WHERE id=ANY($1::text[]) OR
        (entity_type='permission' AND entity_id=$2 AND actor_id=$2 AND action='permission_saved'
          AND created_at=ANY($3::timestamptz[]))`, [receipts.map(receipt => receipt.id), permissionUser, receipts.map(receipt => receipt.created_at)]);
    });
    permissionKeys.length = 0;
  }
  try {
    owns = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('verify-bank-review-http',7241)) AS locked")).rows[0].locked === true;
    truth(owns, "Another HTTP verifier must not be disturbed"); before = await fingerprints(client); await clean(client);
    const count = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS connections,
      (SELECT count(*) FROM bank_account)::int AS accounts,(SELECT count(*) FROM bank_transaction)::int AS tx,
      (SELECT count(*) FROM bank_review_attachment)::int AS attachments`)).rows[0];
    truth(count.connections < 3 && count.accounts < 10 && count.tx < 2000 && count.attachments < 25, "HTTP fixture capacity available");
    await transaction(client, async () => {
      await withReviewLock(client);
      await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete)
        VALUES($1,'plaid','sandbox',$1,'disconnected',true,true)`, [connection]);
      await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency)
        VALUES($1,$2,$1,'Review HTTP fixture','depository','USD')`, [account, connection]);
      await client.query(`INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,
        status,transaction_date,name,source_data,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$1,'123.4500','USD','posted','2026-09-01','HTTP fixture utility','{}'::jsonb,now(),now())`, [tx, connection, account]);
    });
    await api(`/admin/banking/transactions/${tx}/review`, undefined, { anonymous: true, status: 401 });
    await api(`/admin/banking/transactions/${tx}/confirm`, { expected_revision: 0, expected_source_version: 1 }, { anonymous: true, status: 401 });
    jwt = String((await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" })).token);
    truth(jwt && jwt !== "undefined", "Dedicated sandbox operator authentication");
    permissionUser = (await client.query<{ id: string }>("SELECT id FROM public.user WHERE email=$1 AND deleted_at IS NULL", ["sandbox@test.com"])).rows[0]!.id;
    originalPermission = (await client.query<Permission>(`SELECT id,user_id,can_review,can_close,granted_by,
      created_at::text,updated_at::text,deleted_at::text FROM bank_review_permission WHERE user_id=$1`, [permissionUser])).rows[0];
    for (const grant of [false, true]) {
      const permissionKey = randomUUID(); permissionKeys.push(reviewHash([permissionUser, "permission", permissionUser, permissionKey]));
      const savedPermission = await api("/admin/banking/permissions", { user_id: permissionUser, can_review: grant, can_close: grant }, { key: permissionKey });
      equal(record(savedPermission.permission).can_close, grant, "Permission INSERT/UPDATE persists requested flag");
      const listed = (await api("/admin/banking/permissions")).users as Value[];
      equal(listed.find(user => user.id === permissionUser)?.can_review, grant, "Permission GET observes persisted change");
    }
    await restorePermission();
    const accounts = await api("/admin/banking/lookups/accounts?q=");
    const categories = accounts.accounts as Value[];
    truth(categories.length > 0, "Actual cached QB accounts exposed by lookup");
    truth(categories.every(category => category.account_type !== "NonPosting"), "NonPosting excluded from categorization");
    const category = String(categories[0]!.id);
    const parties = (await api("/admin/banking/lookups/parties?q=")).parties as Value[];
    const party = parties.at(-1); truth(party, "Existing party available for HTTP usage ordering");
    await api("/admin/banking/permissions");
    await api(`/admin/banking/accounts/${account}/setup`, { expected_revision: 0, review_start_date: "2026-09-01",
      opening_bank_balance: "1000.12500000", opening_book_balance: "999.75", opening_reference: "HTTP synthetic fixture" });
    const detail = await api(`/admin/banking/transactions/${tx}/review`);
    equal(detail.review, null, "GET does not create a review");
    const version = (review: Value | null) => ({ expected_revision: review?.revision ?? 0, expected_source_version: 1 });
    const saveBody = { ...version(null), mode: "categorize", category_list_id: category,
      counterparty_type: party!.type, counterparty_id: party!.id, comment: "HTTP persisted comment" };
    const key = randomUUID();
    await api(`/admin/banking/transactions/${tx}/review`, saveBody, { key: "", status: 400 });
    const saved = await api(`/admin/banking/transactions/${tx}/review`, saveBody, { key });
    equal(((await api("/admin/banking/lookups/parties?q=")).parties as Value[])[0]?.id, party!.id, "HTTP usage ranking promotes chosen party");
    equal(await api(`/admin/banking/transactions/${tx}/review`, saveBody, { key }), saved, "HTTP retry returns original persisted review");
    await api(`/admin/banking/transactions/${tx}/review`, { ...saveBody, comment: "conflicting retry" }, { key, status: 409 });
    let review = record(saved.review);
    await api(`/admin/banking/transactions/${tx}/confirm`, { ...version(review), expected_source_version: 999 }, { status: 409 });
    review = record((await api(`/admin/banking/transactions/${tx}/confirm`, version(review))).review);
    equal(review.status, "confirmed", "Confirm prepares for audit");
    const pdf = Buffer.from("%PDF-1.4\nHTTP attachment evidence\n%%EOF");
    const added = await api(`/admin/banking/transactions/${tx}/attachments`, { ...version(review), name: "receipt.pdf",
      mime_type: "application/pdf", content_base64: pdf.toString("base64") });
    const attachment = record(added.attachment); entityIds.push(String(attachment.id)); review = record(added.review);
    equal(review.status, "draft", "Adding evidence invalidates preliminary confirmation");
    const path = `/admin/banking/attachments/${String(attachment.id)}/download`;
    await api(path, undefined, { anonymous: true, status: 401 });
    const downloaded = await fetch(`http://localhost:9099${path}`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(10000) });
    equal(downloaded.status, 200, "Authorized download");
    truth(downloaded.headers.get("content-disposition")?.startsWith("attachment;"), "Download forces attachment");
    equal(downloaded.headers.get("x-content-type-options"), "nosniff", "Download disables MIME sniffing");
    equal(Buffer.from(await downloaded.arrayBuffer()), pdf, "HTTP download preserves original bytes");
    const reloaded = await api(`/admin/banking/transactions/${tx}/review`);
    equal(record(reloaded.review).comment, "HTTP persisted comment", "Reload proves persistence");
    truth(!JSON.stringify(reloaded).includes(pdf.toString("base64")), "Detail and audit do not expose blobs");
    const replacementBody = { ...version(review), name: "replacement.pdf", mime_type: "application/pdf", content_base64: pdf.toString("base64") };
    const replacementKey = randomUUID();
    const replacement = await api(`/admin/banking/transactions/${tx}/attachments`, replacementBody, { key: replacementKey });
    equal(await api(`/admin/banking/transactions/${tx}/attachments`, replacementBody, { key: replacementKey }), replacement, "HTTP replacement retry is idempotent");
    const currentAttachment = record(replacement.attachment); entityIds.push(String(currentAttachment.id)); review = record(replacement.review);
    const currentFiles = (await api(`/admin/banking/transactions/${tx}/review`)).attachments as Value[];
    equal(currentFiles.map(item => item.id), [currentAttachment.id], "HTTP shows one current PDF after replacement");
    await api(`/admin/banking/transactions/${tx}/attachments`, replacementBody, { status: 409 });
    await api(`/admin/banking/transactions/${tx}/attachments`, { ...version(review), name: "image.png", mime_type: "image/png", content_base64: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") }, { status: 400 });
    equal((await fetch(`http://localhost:9099${path}`, { headers: { Authorization: `Bearer ${jwt}` } })).status, 200, "Replaced PDF remains downloadable for audit");
    review = record((await api(`/admin/banking/attachments/${String(currentAttachment.id)}/detach`, version(review))).review);
    review = record((await api(`/admin/banking/transactions/${tx}/exclude`, { ...version(review), reason: "HTTP duplicate control" })).review);
    equal(review.status, "excluded", "Exclusion persists");
    review = record((await api(`/admin/banking/transactions/${tx}/return`, version(review))).review);
    equal(review.status, "draft", "Undo restores draft");
    const page = await api(`/admin/banking/transactions?account_id=${account}&q=HTTP&date_from=2026-09-01&date_to=2026-09-01&review_status=pending&limit=1`);
    equal(page.count, 1, "Real SQL date/text/review filters agree with count");
    equal((page.transactions as Value[])[0]?.amount, "-123.4500", "HTTP exposes exact major-unit amount");
    await api("/admin/banking/daily?date=2026-02-30", undefined, { status: 400 });
    await api("/admin/banking/rules");
    const foreign = await client.query(`SELECT 1 FROM bank_review_event WHERE transaction_id=$1
      AND (details::text LIKE $2 OR result::text LIKE $2)`, [tx, `%${pdf.toString("base64")}%`]);
    truth(!foreign.rowCount, "No audit or receipt duplicates the attachment content");
    console.log(JSON.stringify({ measurement: "lookup_http", requests: lookupMeasurements.length, fanout_requests: 0,
      gzip_bytes_combined: gzipSync(lookupMeasurements.map(sample => sample.text).join("")).length,
      samples: lookupMeasurements.map(({ text: _text, ...sample }) => sample) }));
    await clean(client); // The global daily view must not include temporary HTTP fixtures.
    console.log(`PASS bank review HTTP phase: ${assertions} assertions; starting real browser verification`);
    await browserWithSetupRestore(client);
    await transaction(client, async () => {
      await withReviewLock(client);
      const limits = { bank_connection: 3, bank_account: 10, bank_transaction: 2000,
        bank_sync_run: 100, bank_webhook_event: 2000, bank_transaction_review: 2000,
        bank_review_rule: 100, bank_review_event: 10000, bank_day_close: 62,
        bank_review_attachment: 25, bank_review_permission: 25 };
      const counts: Record<string, number> = {};
      for (const [table, limit] of Object.entries(limits)) {
        counts[table] = Number((await client.query(`SELECT COUNT(*)::integer AS n FROM ${table}`)).rows[0].n);
        truth(counts[table]! <= limit, `Sandbox ${table} stays within approved capacity`);
      }
      const largest = Number((await client.query("SELECT COALESCE(MAX(size_bytes),0) AS n FROM bank_review_attachment")).rows[0].n);
      truth(largest <= 5242880, "Attachment sizes stay within approved capacity");
      console.log(JSON.stringify({ measurement: "banking_final_capacity", counts, largest_attachment_bytes: largest }));
    });
  } finally {
    try {
      if (owns) { await restorePermission(); await clean(client); if (before) equal(await fingerprints(client), before, "All eight financial fingerprints unchanged");
        await client.query("SELECT pg_advisory_unlock(hashtextextended('verify-bank-review-http',7241))"); }
    } finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank review HTTP: ${assertions} assertions; own fixtures removed; financial fingerprints unchanged`);
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "BANK_REVIEW_HTTP_FAILED"); process.exitCode = 1; });
