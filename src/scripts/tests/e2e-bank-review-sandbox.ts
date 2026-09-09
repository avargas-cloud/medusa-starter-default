/** Isolated review fixtures; financial documents and QuickBooks are strictly read-only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { saveAccounts } from "../../lib/banking/accounts";
import { mapBankAccount } from "../../lib/banking/actions";
import { applyFeedBatch, type FeedTransaction } from "../../lib/banking/sync-store";
import { saveAccountSetup } from "../../lib/banking/review-setup";
import { saveTransactionReview, confirmTransactionReview, changeTransactionReviewState } from "../../lib/banking/review-core";
import { addReviewAttachment, detachReviewAttachment, downloadReviewAttachment } from "../../lib/banking/review-attachments";
import { previewReviewRule, saveReviewRule } from "../../lib/banking/review-rules";
import { bankingTransactions } from "../../lib/banking/views";
import { matchCandidates } from "../../lib/banking/review-matching";
import { lookupAccounts, lookupParties } from "../../lib/banking/review-lookups";
import { readDailyReview } from "../../lib/banking/review-daily-read";
import { confirmDailyReview, reopenDailyReview } from "../../lib/banking/review-daily";
import type { Review, ReviewVersions } from "../../lib/banking/review-types";
const connection = "bconn_e2e_bank_review";
const actor = "e2e-bank-review";
const days = [1, 2, 3, 4, 5].map(day => `2026-07-0${day}`);
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;
let assertions = 0;
const equal = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); assertions++; };
const truth = (value: unknown, label: string) => { assert.ok(value, label); assertions++; };
async function rejects(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (error: unknown) => error instanceof Error && "code" in error && error.code === code); assertions++;
}
async function fingerprint(client: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of financialTables) result[table] = (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash FROM ${table} t`)).rows[0];
  return result;
}
async function clean(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(`DELETE FROM bank_review_event WHERE actor_id=$1 OR transaction_id IN
      (SELECT id FROM bank_transaction WHERE connection_id=$2)`, [actor, connection]);
    for (const table of ["bank_review_attachment", "bank_transaction_review"]) await client.query(
      `DELETE FROM ${table} WHERE transaction_id IN (SELECT id FROM bank_transaction WHERE connection_id=$1)`, [connection]);
    await client.query("DELETE FROM bank_review_rule WHERE account_id IN (SELECT id FROM bank_account WHERE connection_id=$1)", [connection]);
    await client.query("DELETE FROM bank_day_close WHERE day=ANY($1::text[]) AND (closed_by=$2 OR reopened_by=$2)", [days, actor]);
    for (const table of ["bank_sync_run", "bank_webhook_event", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
  });
}
const feed = (id: string, account: string, date: string, amount = "123.45"): FeedTransaction => ({
  transaction_id: id, account_id: account, date, amount, currency: account === "eur" ? "EUR" : "USD",
  unofficial_currency: null, authorized_date: null, merchant_name: "ACME POWER", name: `ACME POWER ${id}`,
  pending: false, pending_transaction_id: null, source: { id, account, date, amount, name: `ACME POWER ${id}` },
});
async function main() {
  configureBankSandbox();
  const pool = getDbPool(); const client = await pool.connect();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("EXTERNAL_HTTP_FORBIDDEN_IN_REVIEW_TEST"); };
  let before: Record<string, unknown> | undefined;
  let temporary: { id: string; review_start_date: string | null; setup_revision: number } | undefined;
  let owned = false;
  try {
    owned = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-review-fixtures',7241)) AS locked")).rows[0].locked === true;
    truth(owned, "Do not disturb another review fixture run"); before = await fingerprint(client); await clean(client);
    truth(!(await client.query("SELECT 1 FROM bank_day_close WHERE day=ANY($1::text[]) LIMIT 1", [days])).rowCount, "Fixture dates are unowned");
    const counts = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS connections,
      (SELECT count(*) FROM bank_account)::int AS accounts,(SELECT count(*) FROM bank_transaction)::int AS tx,
      (SELECT count(*) FROM bank_review_attachment)::int AS attachments`)).rows[0];
    truth(counts.connections < 3 && counts.accounts <= 6 && counts.tx < 1900 && counts.attachments <= 22, "Fixture capacity available");
    await transaction(client, async () => {
      await withReviewLock(client);
      temporary = (await client.query<{ id: string; review_start_date: string | null; setup_revision: number }>(
        "SELECT id,review_start_date,setup_revision FROM bank_account WHERE name='EPT Sandbox checking' AND deleted_at IS NULL FOR UPDATE")).rows[0];
      if (temporary) await client.query("UPDATE bank_account SET review_start_date='2026-09-01',setup_revision=setup_revision+1 WHERE id=$1", [temporary.id]);
      await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete)
        VALUES($1,'plaid','sandbox',$1,'active',true,true)`, [connection]);
      await saveAccounts(client, connection, ["usd", "eur", "empty", "boundary"].map(id => ({ account_id: id,
        name: `Review fixture ${id}`, type: "depository", subtype: "checking",
        balances: { iso_currency_code: id === "eur" ? "EUR" : "USD", current: "1000.00" } })));
    });
    const accounts = (await client.query<{ id: string; provider_account_id: string }>("SELECT id,provider_account_id FROM bank_account WHERE connection_id=$1", [connection])).rows;
    const account = (id: string) => accounts.find(row => row.provider_account_id === id)!.id;
    const setup = (id: string, start = "2026-07-01") => saveAccountSetup(actor, account(id), randomUUID(), {
      expected_revision: 0, review_start_date: start, opening_bank_balance: "9876543210.12345678", opening_reference: "Synthetic opening fixture",
    });
    for (const id of ["usd", "eur", "empty"]) await setup(id);
    const sources = [...days.map((date, i) => feed(`day${i + 1}`, "usd", date)), feed("euro", "eur", days[0]!, "1.23"),
      feed("before", "boundary", "2026-08-31"), feed("start", "boundary", "2026-09-01")];
    const ingest = (added: FeedTransaction[] = [], modified: FeedTransaction[] = [], removed: { transaction_id: string }[] = []) =>
      transaction(client, () => applyFeedBatch(client, connection, { added, modified, removed, cursor: randomUUID(), initialComplete: true, historicalComplete: true }));
    await ingest(sources);
    const id = async (providerId: string) => (await client.query<{ id: string }>(
      "SELECT id FROM bank_transaction WHERE connection_id=$1 AND provider_transaction_id=$2", [connection, providerId])).rows[0]!.id;
    const review = async (transactionId: string) => (await client.query<Review>(
      "SELECT * FROM bank_transaction_review WHERE transaction_id=$1", [transactionId])).rows[0];
    const versions = async (transactionId: string): Promise<ReviewVersions> => ({ expected_revision: (await review(transactionId))?.revision ?? 0,
      expected_source_version: (await client.query("SELECT source_version FROM bank_transaction WHERE id=$1", [transactionId])).rows[0].source_version });
    const categories = (await client.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE is_active
      AND deleted_at IS NULL AND account_type<>'NonPosting' ORDER BY qb_list_id LIMIT 2`)).rows;
    truth(categories.length === 2, "Two real cached QB posting accounts are read-only controls");
    const category = categories[0]!.qb_list_id; const otherCategory = categories[1]!.qb_list_id;
    const save = async (transactionId: string, selected = category, comment = "Fixture comment") => saveTransactionReview(transactionId, actor, randomUUID(), {
      ...await versions(transactionId), mode: "categorize", category_list_id: selected, comment });
    const confirm = async (transactionId: string) => confirmTransactionReview(transactionId, actor, randomUUID(), await versions(transactionId));
    const boundary = await id("start"); await save(boundary);
    await rejects(async () => confirm(boundary), "BANKING_ACCOUNT_SETUP_REQUIRED"); await setup("boundary", "2026-09-01");
    equal((await bankingTransactions({ account_id: account("boundary"), offset: 0, limit: 10 })).count, 1, "Default queue begins Sep1");
    equal((await bankingTransactions({ account_id: account("boundary"), history: true, offset: 0, limit: 10 })).count, 2, "Aug31 stays accessible as history");
    const beforeId = await id("before"); await rejects(() => save(beforeId), "BANKING_TRANSACTION_BEFORE_REVIEW_START");
    const body = { ...await versions(boundary), mode: "categorize" as const, category_list_id: category, comment: "Retry comment" };
    const key = randomUUID();
    const retries = await Promise.all([saveTransactionReview(boundary, actor, key, body), saveTransactionReview(boundary, actor, key, body)]);
    equal(JSON.parse(JSON.stringify(retries[0])), JSON.parse(JSON.stringify(retries[1])), "Concurrent same receipt returns one persisted result");
    await rejects(() => saveTransactionReview(boundary, actor, key, { ...body, comment: "Different" }), "BANKING_IDEMPOTENCY_CONFLICT");
    await rejects(() => confirmTransactionReview(boundary, actor, randomUUID(), body), "BANKING_REVIEW_VERSION_CONFLICT");
    await confirm(boundary);
    const state = async (action: "return" | "exclude", reason?: string) => changeTransactionReviewState(boundary, actor, randomUUID(), action, { ...await versions(boundary), reason });
    await rejects(() => state("exclude"), "BANKING_EXCLUSION_REASON_REQUIRED");
    equal((await state("exclude", "Duplicate bank evidence")).review.status, "excluded", "Exclude is audited");
    await rejects(() => save(boundary), "BANKING_RESTORE_REQUIRED");
    equal((await state("return")).review.status, "draft", "Restore returns to draft");
    const ruleInput = { name: "Fixture electricity", account_id: account("usd"), active: true, priority: 10,
      match_field: "merchant" as const, pattern: "ACME POWER", direction: "out" as const, currency: "USD", category_list_id: category };
    const preview = await previewReviewRule(actor, ruleInput);
    equal(preview.days, days, "Rule preview includes all past open days");
    let rule = (await saveReviewRule(actor, randomUUID(), { ...ruleInput, preview_hash: preview.preview_hash })).rule;
    const ids = await Promise.all(["day1", "day2", "day3", "day4", "day5"].map(id));
    equal((await review(ids[0]!))?.origin, "rule", "Persisted automatic proposal");
    await save(ids[2]!, otherCategory, "Manual override survives");
    await confirm(ids[1]!);
    const pdfA = Buffer.from("%PDF-1.4\nfixture A\n%%EOF").toString("base64");
    const attachmentA = await addReviewAttachment(ids[3]!, actor, randomUUID(), { ...await versions(ids[3]!), name: "evidence.pdf", mime_type: "application/pdf", content_base64: pdfA });
    truth(attachmentA.attachment, "Attachment insertion returned evidence");
    equal((await downloadReviewAttachment(attachmentA.attachment!.id)).bytes.toString("base64"), pdfA, "Private attachment persists exact bytes");
    await confirm(ids[3]!);
    const oldClose = await readDailyReview(days[3]!);
    truth(oldClose.can_close, `All applicable accounts ready: ${oldClose.blockers.join("; ")}`);
    truth(oldClose.accounts.some(block => block.account.id === account("empty") && !block.transactions.length), "Empty imported account is present");
    await save(ids[3]!, category, "Comment edited after auditor loaded day"); await confirm(ids[3]!);
    await rejects(() => confirmDailyReview(actor, randomUUID(), { date: days[3]!, expected_revision: oldClose.revision, input_hash: oldClose.input_hash }), "BANKING_DAY_CHANGED");
    const close = async (date: string) => { const state = await readDailyReview(date);
      return confirmDailyReview(actor, randomUUID(), { date, expected_revision: state.revision, input_hash: state.input_hash }); };
    const closing = await readDailyReview(days[3]!); const closeKey = randomUUID();
    const closeBody = { date: days[3]!, expected_revision: closing.revision, input_hash: closing.input_hash };
    const closedRetries = await Promise.all([confirmDailyReview(actor, closeKey, closeBody), confirmDailyReview(actor, closeKey, closeBody)]);
    equal(closedRetries[0], closedRetries[1], "Concurrent close retry yields one revision");
    equal((await readDailyReview(days[3]!)).needs_review, false, "Fresh closure has no self-inflicted hash mismatch");
    await transaction(client, async () => { await withReviewLock(client);
      await client.query("UPDATE bank_account SET is_selected=true,balances=jsonb_build_object('current','9999.99') WHERE id=$1", [account("usd")]); });
    equal((await readDailyReview(days[3]!)).needs_review, false, "Selection and live balance refresh do not alter historical evidence hash");
    const bankMapping = (await client.query<{ qb_list_id: string }>(`SELECT q.qb_list_id FROM qb_account q
      WHERE q.is_active AND q.deleted_at IS NULL AND q.account_type='Bank'
      AND NOT EXISTS(SELECT 1 FROM bank_account a WHERE a.qb_list_id=q.qb_list_id AND a.is_active AND a.deleted_at IS NULL) LIMIT 1`)).rows[0];
    truth(bankMapping, "A valid cached unmapped bank category is available as a negative control");
    await rejects(() => mapBankAccount(account("usd"), bankMapping!.qb_list_id), "BANKING_REOPEN_REQUIRED");
    await mapBankAccount(account("usd"), null);
    await rejects(() => saveAccountSetup(actor, account("usd"), randomUUID(), { expected_revision: 1,
      review_start_date: "2026-07-01", opening_bank_balance: "1", opening_reference: "Must reject" }), "BANKING_REOPEN_REQUIRED");
    equal((await matchCandidates(boundary, "")).supported, false, "Outgoing debit cannot match customer receipt");
    const payment = (await client.query<{ id: string; amount: string }>(`SELECT p.id,(-p.amount::numeric/100)::text AS amount
      FROM customer_payment p JOIN customer c ON c.id=p.customer_id AND c.deleted_at IS NULL
      WHERE p.type='payment' AND p.method IN ('ach','zelle','check') AND p.status IN ('available','partially_applied','applied')
        AND p.amount::numeric>0 AND upper(p.currency)='USD' AND p.deleted_at IS NULL
        AND COALESCE(p.metadata->>'qb_import','false')='false'
        AND NOT EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.matched_payment_id=p.id AND r.status<>'excluded' AND r.deleted_at IS NULL)
      ORDER BY p.id LIMIT 1`)).rows[0];
    if (payment) {
      await ingest([feed("match1", "usd", days[4]!, payment.amount), feed("match2", "usd", days[4]!, payment.amount)]);
      const matchIds = await Promise.all(["match1", "match2"].map(id));
      const candidate = (await matchCandidates(matchIds[0]!, "")).candidates.find(row => row.id === payment.id);
      const match = async (which: string) => saveTransactionReview(which, actor, randomUUID(), {
        ...await versions(which), mode: "match", matched_payment_id: payment.id, expected_match_source_hash: candidate?.source_hash, comment: "Exact existing receipt" });
      truth(candidate, "Exact cents-to-major candidate is available");
      await match(matchIds[0]!); await confirm(matchIds[0]!);
      await rejects(() => match(matchIds[1]!), "BANKING_MATCH_INVALID_OR_RESERVED");
      await changeTransactionReviewState(matchIds[0]!, actor, randomUUID(), "return", await versions(matchIds[0]!));
      await match(matchIds[1]!);
      for (const matchId of matchIds) await changeTransactionReviewState(matchId, actor, randomUUID(), "exclude", { ...await versions(matchId), reason: "Fixture complete" });
    } else console.log("GAP: no eligible existing monetary receipt; positive Match requires read-only fixture evidence");
    const changedInput = { ...ruleInput, id: rule.id, expected_version: rule.version, category_list_id: otherCategory };
    const changedPreview = await previewReviewRule(actor, changedInput);
    equal(changedPreview.skipped_closed, 1, "Rule preview skips the closed historical day");
    rule = (await saveReviewRule(actor, randomUUID(), { ...changedInput, preview_hash: changedPreview.preview_hash })).rule;
    equal((await review(ids[1]!))?.status, "draft", "Changing a rule invalidates prior preliminary confirmation");
    equal((await review(ids[2]!))?.comment, "Manual override survives", "Rules preserve manual decisions and comments");
    equal((await review(ids[4]!))?.rule_version, 2, "Rule change reaches later open days");
    equal((await review(ids[3]!))?.rule_version, 1, "Closed decision retains its original rule version");
    const reopen = async (date: string) => reopenDailyReview(actor, randomUUID(), { date,
      expected_revision: (await readDailyReview(date)).revision, reason: "Review additional source evidence" });
    await reopen(days[3]!);
    equal((await review(ids[3]!))?.rule_version, 2, "Reopening applies the current rule to the now-open day");
    const pdfB = Buffer.from("%PDF-1.4\nfixture B\n%%EOF").toString("base64");
    const replaceKey = randomUUID();
    const replaceBody = { ...await versions(ids[3]!), name: "evidence.pdf", mime_type: "application/pdf", content_base64: pdfB };
    const attachmentB = await addReviewAttachment(ids[3]!, actor, replaceKey, replaceBody);
    equal(JSON.parse(JSON.stringify(await addReviewAttachment(ids[3]!, actor, replaceKey, replaceBody))),
      JSON.parse(JSON.stringify(attachmentB)), "Replacement retry does not create another PDF version");
    await rejects(() => addReviewAttachment(ids[3]!, actor, randomUUID(), replaceBody), "BANKING_REVIEW_VERSION_CONFLICT");
    const history = (await client.query("SELECT history FROM bank_day_close WHERE day=$1", [days[3]])).rows[0].history;
    truth(JSON.stringify(history).includes(attachmentA.attachment!.sha256), "Original snapshot preserves attachment A after same-name attachment B");
    truth(!JSON.stringify(history).includes(pdfA) && !JSON.stringify(history).includes(pdfB), "Closed history stores hashes, not blobs");
    const replacedBlock = (await readDailyReview(days[3]!)).accounts.find(block => block.account.id === account("usd"));
    equal(replacedBlock?.transactions.find(row => row.id === ids[3])?.attachments?.map(file => file.id), [attachmentB.attachment!.id], "Daily review exposes exactly the current replacement PDF");
    equal(replacedBlock?.totals[0]?.money_out, "123.45", "Historical file versions and events do not multiply money");
    const pauseInput = { ...changedInput, expected_version: rule.version, active: false };
    const pausePreview = await previewReviewRule(actor, pauseInput);
    await saveReviewRule(actor, randomUUID(), { ...pauseInput, preview_hash: pausePreview.preview_hash });
    equal((await review(ids[4]!))?.category_list_id, null, "Pausing rule removes its automatic proposal");
    equal((await review(ids[2]!))?.category_list_id, otherCategory, "Pausing leaves manual override");
    await rejects(async () => detachReviewAttachment(attachmentA.attachment!.id, actor, randomUUID(), await versions(ids[3]!)), "BANKING_ATTACHMENT_ALREADY_DETACHED");
    equal((await downloadReviewAttachment(attachmentA.attachment!.id)).bytes.toString("base64"), pdfA, "Detached historical blob remains retrievable");
    await save(boundary); await confirm(boundary);
    const revised = feed("start", "boundary", "2026-09-01", "123.46"); await ingest([], [revised]);
    equal((await review(boundary))?.source_version, 1, "Changed source does not recertify old decision");
    const staleAttachment = await addReviewAttachment(boundary, actor, randomUUID(), { ...await versions(boundary),
      name: "new-source.pdf", mime_type: "application/pdf", content_base64: pdfA });
    equal(staleAttachment.review.source_version, 1, "Attaching evidence cannot silently accept changed money");
    await rejects(() => confirm(boundary), "BANKING_REVIEW_STALE");
    await detachReviewAttachment(staleAttachment.attachment!.id, actor, randomUUID(), await versions(boundary));
    await rejects(() => confirm(boundary), "BANKING_REVIEW_STALE");
    await save(boundary); await confirm(boundary);
    const accepted = await review(boundary); await ingest([], [revised]);
    equal(await review(boundary), accepted, "Identical ingestion replay preserves accepted review revision");
    for (const transactionId of [ids[0]!, ids[1]!, await id("euro")]) { await save(transactionId); await confirm(transactionId); }
    const moneyDay = await readDailyReview(days[0]!);
    equal(moneyDay.accounts.find(block => block.account.id === account("eur"))?.totals[0]?.money_out, "1.23", "EUR remains in its own account total");
    equal(moneyDay.accounts.find(block => block.account.id === account("usd"))?.totals[0]?.money_out, "123.45", "USD amount remains major units");
    await confirm(ids[2]!);
    const raceDay = await readDailyReview(days[2]!); const raceVersions = await versions(ids[2]!);
    const race = await Promise.allSettled([
      confirmDailyReview(actor, randomUUID(), { date: days[2]!, expected_revision: raceDay.revision, input_hash: raceDay.input_hash }),
      saveTransactionReview(ids[2]!, actor, randomUUID(), { ...raceVersions, mode: "categorize", category_list_id: otherCategory, comment: "Concurrent edit" }),
    ]);
    equal(race.filter(result => result.status === "fulfilled").length, 1, "Concurrent edit and close cannot certify different evidence");
    truth(race.some(result => result.status === "rejected" && ["BANKING_DAY_CLOSED", "BANKING_DAY_CHANGED"].includes(result.reason?.code)), "Race loses at the named closed-day/hash guard");
    await close(days[0]!); await close(days[1]!);
    const snapshots = async () => (await client.query("SELECT day,snapshot FROM bank_day_close WHERE day=ANY($1::text[]) ORDER BY day", [days.slice(0, 2)])).rows;
    const originals = await snapshots();
    const moved = feed("day1", "usd", days[1]!, "777.12");
    await ingest([], [sources[0]!]);
    equal((await readDailyReview(days[0]!)).needs_review, false, "Identical source replay never invalidates closed certification");
    await rejects(() => ingest([], [moved, feed("missing", "absent-account", days[0]!)]), "BANKING_ACCOUNT_MISSING");
    equal((await readDailyReview(days[0]!)).needs_review, false, "Failed ingestion cannot dirty the closed day");
    await ingest([], [moved]);
    equal((await readDailyReview(days[0]!)).needs_review, true, "Moved source marks its old closed day");
    equal((await readDailyReview(days[1]!)).needs_review, true, "Moved source marks its new closed day");
    equal(await snapshots(), originals, "Source amount/date changes preserve both original close snapshots");
    await ingest([], [], [{ transaction_id: "day1" }]);
    equal(await snapshots(), originals, "Removed source also preserves historical close evidence");
    const pending = { ...feed("pending-closed", "usd", days[0]!), pending: true };
    await ingest([pending]);
    await ingest([{ ...feed("posted-closed", "usd", days[1]!, "122.22"), pending_transaction_id: "pending-closed" }]);
    equal((await client.query("SELECT status FROM bank_transaction WHERE id=$1", [await id("pending-closed")])).rows[0].status,
      "removed", "Pending source is replaced after both calendar days were closed");
    equal(await snapshots(), originals, "Pending-to-posted transition preserves both closed snapshots");
    const selectedParty = (await lookupParties("")).parties.at(-1)!;
    truth(selectedParty, "A real vendor/customer lookup control exists");
    await saveTransactionReview(boundary, actor, randomUUID(), { ...await versions(boundary), mode: "categorize",
      category_list_id: category, counterparty_id: selectedParty.id, counterparty_type: selectedParty.type, comment: "Usage ranking fixture" });
    const lookupStart = performance.now(); const rankedCategories = await lookupAccounts("");
    const categoryMs = performance.now() - lookupStart; const partyStart = performance.now(); const rankedParties = await lookupParties("");
    const partyMs = performance.now() - partyStart;
    equal(rankedCategories.accounts[0]?.id, category, "Most-used category ranks first without a search");
    equal(rankedParties.parties[0]?.id, selectedParty.id, "Used party moves ahead of unused alphabetical results");
    equal((await lookupAccounts(rankedCategories.accounts[0]!.name)).accounts[0]?.id, category, "Typed category matches retain usage order");
    equal((await lookupParties(selectedParty.name)).parties[0]?.id, selectedParty.id, "Typed party matches retain usage order");
    const payload = Buffer.from(JSON.stringify([rankedCategories, rankedParties]));
    console.log(JSON.stringify({ measurement: "lookup_db_helper", requests: 2, fanout_requests: 0,
      category_count: rankedCategories.count, party_count: rankedParties.count, returned: [rankedCategories.accounts.length, rankedParties.parties.length],
      bytes: payload.length, gzip_bytes: gzipSync(payload).length, elapsed_ms: [Math.round(categoryMs), Math.round(partyMs)] }));
    truth(!(await client.query("SELECT 1 FROM bank_review_event WHERE actor_id=$1 AND (details::text LIKE $2 OR result::text LIKE $2)", [actor, `%${pdfA}%`])).rowCount, "Audit and receipt do not duplicate file payloads");
  } finally {
    globalThis.fetch = originalFetch;
    try {
      if (owned) {
        await clean(client);
        if (temporary) await transaction(client, async () => {
          await withReviewLock(client);
          const restored = await client.query(`UPDATE bank_account SET review_start_date=$2,setup_revision=$3
            WHERE id=$1 AND setup_revision=$4 AND review_start_date='2026-09-01'`,
          [temporary!.id, temporary!.review_start_date, temporary!.setup_revision, temporary!.setup_revision + 1]);
          equal(restored.rowCount, 1, "Temporary session-owned account start restored with CAS");
        });
        if (before) equal(await fingerprint(client), before, "Eight financial and QB pipeline fingerprints unchanged");
        await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-review-fixtures',7241))");
      }
    } finally { client.release(); await pool.end(); }
  }
  console.log(`PASS banking review integration: ${assertions} assertions; own fixtures cleaned; financial fingerprints unchanged`);
}
void main().catch((error: unknown) => {
  const location = error instanceof Error ? error.stack?.split("\n").filter(line => /src\/(lib\/banking|scripts\/tests\/e2e-bank-review)/.test(line)).join("\n") : "";
  console.error(error instanceof Error ? error.message : "BANK_REVIEW_E2E_FAILED", location); process.exitCode = 1;
});
