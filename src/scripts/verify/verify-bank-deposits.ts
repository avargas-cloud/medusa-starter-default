/** V7 integration: only owned banking fixtures mutate; monetary source documents remain read-only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { PAYMENT_FINGERPRINT_SQL } from "../../lib/banking/review-projection";
import { saveBankDeposit, readyBankDeposit, voidBankDeposit } from "../../lib/banking/deposit-core";
import { readBankDeposit, depositCandidates, listBankDeposits } from "../../lib/banking/deposit-read";
import { transactionDepositCandidates, depositSuggestions } from "../../lib/banking/deposit-matching";
import { saveTransactionReview, confirmTransactionReview, changeTransactionReviewState } from "../../lib/banking/review-core";
import { matchCandidates } from "../../lib/banking/review-matching";
import { invalidateBankSource } from "../../lib/banking/review-source";
import { readTransactionReview } from "../../lib/banking/review-read";

const actor = "v7verify_bank_deposits";
const connection = "bconn_v7verify_deposit"; const account = "bacc_v7verify_deposit";
const day = "2026-08-19"; const txPrefix = "btx_v7verify_deposit_";
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;
let checks = 0;
function truth(value: unknown, label: string): asserts value { assert.ok(value, label); checks++; }
function same(a: unknown, b: unknown, label: string) { truth(isDeepStrictEqual(a,b),label); }
function cents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(value);
  assert(match, "Expected an exact nonnegative monetary amount");
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}
function major(value: bigint): string { return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`; }
async function fingerprints(client: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of financialTables) result[table] = (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash FROM ${table} t`)).rows[0];
  return result;
}
async function rejectCode(run: () => Promise<unknown>, code: string) {
  try { await run(); } catch (error) {
    const actual = error instanceof Error && "code" in error ? String(error.code) : "untyped-error";
    truth(actual===code, `Expected ${code}; received ${actual}`); return;
  }
  throw new Error(`Expected ${code}, but operation succeeded`);
}
async function mutate(client: PoolClient, run: () => Promise<void>) {
  await transaction(client, async () => { await withReviewLock(client); await run(); });
}
type Receipt = { id: string; amount: string; source_hash: string; customer_id: string; display_id: number };
async function receipts(client: PoolClient): Promise<Receipt[]> {
  return (await client.query<Receipt>(`SELECT DISTINCT ON(mp.customer_id) mp.id,mp.display_id,(mp.amount::numeric/100)::text AS amount,
    mp.customer_id,${PAYMENT_FINGERPRINT_SQL} AS source_hash FROM customer_payment mp
    JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE mp.deleted_at IS NULL AND mp.type='payment' AND mp.method IN('ach','zelle','check')
      AND mp.status IN('available','partially_applied','applied') AND mp.amount::numeric>=200
      AND upper(mp.currency)='USD' AND mp.display_id IS NOT NULL AND COALESCE(mp.metadata->>'qb_import','false')='false'
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date BETWEEN '2026-01-01'::date AND $1::date
      AND NOT EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.matched_payment_id=mp.id
        AND r.status<>'excluded' AND r.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM bank_deposit_line dl JOIN bank_deposit d ON d.id=dl.deposit_id
        WHERE dl.payment_id=mp.id AND dl.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status<>'void')
    ORDER BY mp.customer_id,mp.id LIMIT 2`,[day])).rows;
}

async function clean(client: PoolClient) {
  await mutate(client, async () => {
    await client.query(`DELETE FROM bank_review_event WHERE actor_id=$1 OR transaction_id IN
      (SELECT id FROM bank_transaction WHERE connection_id=$2)`, [actor, connection]);
    for (const table of ["bank_review_attachment", "bank_transaction_review"]) await client.query(
      `DELETE FROM ${table} WHERE transaction_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)`, [connection]);
    await client.query("DELETE FROM bank_deposit_line WHERE deposit_id IN(SELECT id FROM bank_deposit WHERE account_id=$1)", [account]);
    await client.query("DELETE FROM bank_deposit WHERE account_id=$1", [account]);
    await client.query("DELETE FROM bank_day_close WHERE id='bdc_v7verify_deposit'");
    for (const table of ["bank_webhook_event", "bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
  });
}

async function main() {
  configureBankSandbox();
  const pool = getDbPool(); const client = await pool.connect();
  let owns = false; let before: Record<string, unknown> | undefined;
  try {
    owns = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('v7verify_bank_deposits',7241)) AS locked")).rows[0].locked === true;
    truth(owns, "Another verifier's banking fixtures must remain untouched");
    before = await fingerprints(client); await clean(client);
    // Exercise real parameter binding on absent targets, including null status/search branches.
    same((await listBankDeposits({ account_id: "v7verify_absent" })).count, 0, "List binds absent account and optional filters");
    same((await transactionDepositCandidates("v7verify_absent")).count, 0, "Grouped candidate query binds a missing movement");
    same(await depositSuggestions(["v7verify_absent"]), [], "Suggestion batch binds missing IDs without writes");
    await rejectCode(() => readBankDeposit("v7verify_absent"), "BANKING_DEPOSIT_NOT_FOUND");
    truth(!(await client.query("SELECT 1 FROM bank_day_close WHERE day=$1 AND deleted_at IS NULL", [day])).rowCount, "Owned fixture day has no existing review closure");
    const [p, q] = await receipts(client); truth(p && q, "Two existing unreserved monetary receipts support positive controls");
    const category = (await client.query<{ id: string }>(`SELECT qb_list_id AS id FROM qb_account WHERE deleted_at IS NULL
      AND is_active AND account_type IN('Expense','OtherExpense') ORDER BY qb_list_id LIMIT 1`)).rows[0];
    truth(category, "An existing posting expense account supports real fee validation");
    await mutate(client, async () => {
      const cap = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS connections,
        (SELECT count(*) FROM bank_account)::int AS accounts,(SELECT count(*) FROM bank_transaction)::int AS transactions`)).rows[0];
      truth(cap.connections<3 && cap.accounts<10 && cap.transactions+2<=2000, "Fixture stays within approved bank-feed caps");
      await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete,last_successful_sync_at)
        VALUES($1,'plaid','sandbox',$1,'disconnected',true,true,now())`, [connection]);
      await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,
        review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
        VALUES($1,$2,$1,'V7 verifier synthetic bank','depository','USD',true,'2026-01-01','0','2025-12-31','Verification fixture only',1)`, [account, connection]);
      for (const [suffix, amount] of [["individual", p.amount], ["group", "1.23"]]) await client.query(`INSERT INTO bank_transaction
        (id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$1,-$4::numeric,'USD','posted',$5,'V7 verifier synthetic deposit','{}'::jsonb,now(),now())`,
      [txPrefix+suffix, connection, account, amount, day]);
    });
    const line = (receipt: Receipt, amount: string) => ({ payment_id: receipt.id, amount, expected_source_hash: receipt.source_hash });
    const body = (lines: ReturnType<typeof line>[]) => ({ expected_revision: 0, account_id: account,
      date: day, reference: "V7 verifier", memo: "Synthetic banking evidence", fee_amount: "0.00", lines });
    const make = async (lines: ReturnType<typeof line>[]) => (await saveBankDeposit(actor, randomUUID(), body(lines))).deposit;
    const discard = async (id: string) => { const { deposit } = await readBankDeposit(id);
      return voidBankDeposit(id, actor, randomUUID(), { expected_revision: deposit.revision, reason: "Release owned verifier reservation" }); };
    const initial = await depositCandidates({ account_id: account, q: String(p.display_id) });
    truth(initial.candidates.some(candidate => candidate.id===p.id), "Candidate query returns the real source receipt");
    same(cents(initial.candidates.find(candidate => candidate.id===p.id)!.available_amount),cents(p.amount),"Bank availability starts at the receipt face value independently of AR status");
    const half = cents(p.amount)/2n;
    const a = await make([line(p,major(half))]);
    const b = await make([line(p,major(cents(p.amount)-half))]);
    same(cents(a.gross_amount)+cents(b.gross_amount), cents(p.amount), "Partial deposits exactly cover one original receipt");
    truth(!(await depositCandidates({ account_id:account,q:String(p.display_id) })).candidates.some(candidate => candidate.id===p.id),"Fully reserved receipt leaves the remaining-cash picker");
    await rejectCode(() => make([line(p,"0.01")]), "BANKING_DEPOSIT_OVER_RESERVED");
    const own = await depositCandidates({ account_id: account, q: String(p.display_id), deposit_id: a.id });
    truth(own.candidates.some(candidate => candidate.id===p.id), "Editing excludes its own reservation from available candidates");
    same(cents(own.candidates.find(candidate => candidate.id===p.id)!.available_amount),half,"Edit picker releases only its own portion when computing remaining capacity");
    await rejectCode(() => saveTransactionReview(txPrefix+"individual", actor, randomUUID(), {
      expected_revision: 0, expected_source_version: 1, mode: "match", matched_payment_id: p.id,
      expected_match_source_hash: p.source_hash, comment: "Cross-reservation control" }), "BANKING_MATCH_INVALID_OR_RESERVED");
    const edited = (await saveBankDeposit(actor,randomUUID(), { ...body([line(p,major(cents(p.amount)-half-1n))]),
      id:b.id,expected_revision:b.revision })).deposit;
    const raced = await Promise.allSettled([make([line(p,"0.01")]),make([line(p,"0.01")])]);
    same(raced.filter(result => result.status==="fulfilled").length,1,"Concurrent deposits cannot both reserve the final cent");
    const loser = raced.find(result => result.status==="rejected");
    truth(loser?.status==="rejected" && loser.reason instanceof Error && "code" in loser.reason
      && loser.reason.code==="BANKING_DEPOSIT_OVER_RESERVED", "Concurrent loser is rejected for source capacity");
    for (const result of raced) if (result.status==="fulfilled") await discard(result.value.id);
    await discard(a.id); await discard(edited.id);
    const liveMatch = (await matchCandidates(txPrefix+"individual","")).candidates.find(candidate => candidate.id===p.id);
    truth(liveMatch, "Voiding deposits restores the previously blocked individual Match candidate");
    const individual = (await saveTransactionReview(txPrefix+"individual",actor,randomUUID(), {
      expected_revision:0,expected_source_version:1,mode:"match",matched_payment_id:p.id,
      expected_match_source_hash:liveMatch.source_hash,comment:"Individual reservation control" })).review;
    await rejectCode(() => make([line(p,"0.01")]), "BANKING_DEPOSIT_OVER_RESERVED");
    await changeTransactionReviewState(txPrefix+"individual",actor,randomUUID(),"return", {
      expected_revision:individual.revision,expected_source_version:1 });
    const feeBody = { ...body([line(p,"1.23"),line(q,"0.01")]),fee_amount:"0.01",
      fee_account_list_id:category.id,fee_reference:"Synthetic statement explicitly lists one-cent fee" };
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,date:"2025-12-31" }), "BANKING_TRANSACTION_BEFORE_REVIEW_START");
    await rejectCode(() => make([line(p,"0.001")]), "BANKING_INVALID_REQUEST");
    await rejectCode(() => make([line(p,"0.00")]), "BANKING_DEPOSIT_AMOUNT_INVALID");
    await rejectCode(() => make([line(p,"0.01"),line(p,"0.01")]), "BANKING_DEPOSIT_LINES_INVALID");
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,fee_account_list_id:null }), "BANKING_DEPOSIT_FEE_ACCOUNT_REQUIRED");
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,fee_reference:"" }), "BANKING_DEPOSIT_FEE_REFERENCE_REQUIRED");
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,fee_account_list_id:"v7verify_missing" }), "BANKING_DEPOSIT_FEE_ACCOUNT_INVALID");
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,fee_amount:"1.24" }), "BANKING_DEPOSIT_NET_INVALID");
    const invalidHash = "0".repeat(32);
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,
      lines:[{ ...line(p,"1.23"),expected_source_hash:invalidHash },line(q,"0.01")] }), "BANKING_DEPOSIT_SOURCE_STALE");
    const key = randomUUID(); const saved = await saveBankDeposit(actor,key,feeBody);
    same(await saveBankDeposit(actor,key,feeBody),saved,"Identical retry returns one original deposit");
    await rejectCode(() => saveBankDeposit(actor,key,{ ...feeBody,memo:"Changed retry intent" }),"BANKING_IDEMPOTENCY_CONFLICT");
    const d = saved.deposit;
    same(new Set(d.lines.map(item => item.customer_id)).size,2,"One deposit preserves two distinct real customers on its lines");
    same([cents(d.gross_amount),cents(d.fee_amount),cents(d.net_amount)],[124n,1n,123n],"Two source portions and explicit fee preserve cents exactly");
    same(cents(d.lines.find(item => item.payment_id===p.id)!.payment_amount),cents(p.amount),"Source receipt cents are exposed as major units exactly once");
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,id:d.id,expected_revision:0 }), "BANKING_DEPOSIT_CONFLICT");
    await rejectCode(() => readyBankDeposit(d.id,actor,randomUUID(), { expected_revision:d.revision,expected_source_hash:invalidHash }), "BANKING_DEPOSIT_SOURCE_STALE");
    // Corrupt only owned banking evidence to simulate an outdated recorded payment hash, never the payment itself.
    await mutate(client,async () => { await client.query("UPDATE bank_deposit_line SET source_hash=$3 WHERE deposit_id=$1 AND payment_id=$2",[d.id,p.id,invalidHash]); });
    const staleDeposit = (await readBankDeposit(d.id)).deposit;
    truth(staleDeposit.stale,"Recorded payment-source mismatch is visible without changing financial documents");
    await rejectCode(() => readyBankDeposit(d.id,actor,randomUUID(), {
      expected_revision:staleDeposit.revision,expected_source_hash:staleDeposit.source_hash }), "BANKING_DEPOSIT_SOURCE_STALE");
    await mutate(client,async () => { await client.query("UPDATE bank_deposit_line SET source_hash=$3 WHERE deposit_id=$1 AND payment_id=$2",[d.id,p.id,p.source_hash]); });
    const ready = (await readyBankDeposit(d.id,actor,randomUUID(), { expected_revision:d.revision,expected_source_hash:d.source_hash })).deposit;
    truth(ready.status==="ready" && !ready.stale,"Validated composition becomes ready with current source evidence");
    const groupBody = { expected_revision:0,expected_source_version:1,mode:"deposit" as const,
      matched_deposit_id:ready.id,expected_deposit_source_hash:ready.source_hash,comment:"Grouped deposit evidence" };
    const individualRevision = (await readTransactionReview(txPrefix+"individual")).review!.revision;
    await rejectCode(() => saveTransactionReview(txPrefix+"individual",actor,randomUUID(), {
      ...groupBody,expected_revision:individualRevision }), "BANKING_DEPOSIT_MATCH_INVALID");
    await rejectCode(() => saveTransactionReview(txPrefix+"group",actor,randomUUID(), {
      ...groupBody,expected_deposit_source_hash:invalidHash }), "BANKING_DEPOSIT_SOURCE_STALE");
    const grouped = (await saveTransactionReview(txPrefix+"group",actor,randomUUID(),groupBody)).review;
    truth(grouped.status==="draft" && grouped.counterparty_id===null,"Linking a grouped deposit remains draft without assigning all receipts to one customer");
    const confirmed = (await confirmTransactionReview(txPrefix+"group",actor,randomUUID(), {
      expected_revision:grouped.revision,expected_source_version:1 })).review;
    truth(confirmed.status==="confirmed","Real confirmation revalidates the linked deposit evidence");
    const snapshot = { date:day,accounts:[{ account:{ id:account },transactions:[{ id:txPrefix+"group",review:confirmed,deposit:ready }] }] };
    await mutate(client,async () => { await client.query(`INSERT INTO bank_day_close
      (id,day,status,snapshot,input_hash,closed_by,closed_at) VALUES('bdc_v7verify_deposit',$1,'closed',$2::jsonb,$3,$4,now())`,
    [day,JSON.stringify(snapshot),"1".repeat(64),actor]); });
    await rejectCode(() => saveBankDeposit(actor,randomUUID(), { ...feeBody,id:ready.id,expected_revision:ready.revision }), "BANKING_DEPOSIT_REOPEN_REQUIRED");
    await rejectCode(() => discard(ready.id), "BANKING_DEPOSIT_REOPEN_REQUIRED");
    await mutate(client,async () => {
      await client.query("UPDATE bank_transaction SET source_version=source_version+1,amount='-1.24' WHERE id=$1",[txPrefix+"group"]);
      await invalidateBankSource(client,txPrefix+"group",day,day);
    });
    const changed = await readTransactionReview(txPrefix+"group");
    truth(changed.stale && changed.day_closed,"Changed bank source is stale while its audited day stays closed");
    const closed = (await client.query("SELECT snapshot,needs_review FROM bank_day_close WHERE id='bdc_v7verify_deposit'")).rows[0];
    same(closed.snapshot,JSON.parse(JSON.stringify(snapshot)),"Bank-source drift preserves closed composition snapshot");
    truth(closed.needs_review,"Source change flags the closed date for operator review");
    same(cents((await readBankDeposit(ready.id)).deposit.gross_amount),124n,"Closed source drift does not silently free grouped receipt portions");
    const remaining = (await depositCandidates({ account_id:account,q:String(p.display_id) })).candidates.find(candidate => candidate.id===p.id);
    truth(remaining,"The receipt still has its expected unreserved remainder");
    same(cents(remaining.available_amount),cents(p.amount)-123n,"Audited deposit portions remain reserved after bank-source drift");
    console.log(JSON.stringify({ coverage:{ partials:true,concurrent_capacity:true,cross_match:true,fees:true,
      retries:true,source_drift:true,closed_guard:true },financial_tables_checked:financialTables.length }));
  } finally {
    try { if (owns) { await clean(client);
      truth(!(await client.query(`SELECT 1 FROM bank_connection WHERE id=$1 UNION ALL
        SELECT 1 FROM bank_deposit WHERE account_id=$2 UNION ALL SELECT 1 FROM bank_review_event WHERE actor_id=$3`,
      [connection,account,actor])).rowCount,"Owned connection, deposits and command events are removed");
      if (before) same(await fingerprints(client), before, "All eight financial fingerprints remain unchanged");
      await client.query("SELECT pg_advisory_unlock(hashtextextended('v7verify_bank_deposits',7241))"); } }
    finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank deposits integration: ${checks} checks; own fixtures removed; financial evidence unchanged`);
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "BANK_DEPOSIT_VERIFY_FAILED"); process.exitCode=1; });
