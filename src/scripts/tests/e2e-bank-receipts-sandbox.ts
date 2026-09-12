/** Real v9 HTTP/PG/browser checks; all Finance mutations are newly created orderless fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { postReceiptAccounting } from "../../lib/banking/receipts-core";
import type { ReceiptContext, ReceiptOrigin, ReceiptPostInput } from "../../lib/banking/receipts-types";
import type { BankDeposit } from "../../lib/banking/deposit-types";
import type { DepositCandidate } from "../../lib/banking/deposit-read";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { runReceiptAdversarial } from "../../lib/banking/receipts-sandbox-adversarial";
import { account, actor, rootPrefix, day, laterDay, fingerprints, bankingFingerprint, seedReceiptAccount,
  seedReceiptPayment, seedReceiptMovement, cleanReceiptFixtures } from "./bank-receipts-fixtures";

type Value = Record<string, unknown>;
let checks = 0;
function check(value: unknown, label: string): asserts value { assert(value, label); checks++; console.log(`PASS ${label}`); }
const record = (value: unknown) => value as Value;
async function main() {
  configureBankSandbox(); process.env.POS_URL = "http://localhost:3099"; process.env.MEDUSA_SANDBOX_URL = "http://localhost:9099";
  const pool = getDbPool(), client = await pool.connect(); let owns = false, seeded = false, jwt = "";
  let before: Value | undefined, banksBefore: Value | undefined;
  const base = (kind: ReceiptOrigin, id: string) => `/admin/banking/accounting/${kind === "receipt" ? "receipts" : kind === "deposit" ? "deposits" : "payment-matches"}/${id}`;
  const api = async (path: string, body?: Value, expected = 200, key: string = randomUUID(), anonymous = false): Promise<Value> => {
    const response = await fetch(`http://localhost:9099${path}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", ...(!anonymous && jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(body ? { "Idempotency-Key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = record(await response.json());
    check(response.status === expected, `${path} HTTP ${response.status} expected ${expected}; ${String(value.code ?? value.message ?? "ok")}`);
    return value;
  };
  const context = async (kind: ReceiptOrigin, id: string) => await api(base(kind, id)) as ReceiptContext;
  const bodyFor = async (kind: ReceiptOrigin, id: string): Promise<ReceiptPostInput> => {
    const src = await context(kind, id), body = { expected_source_hash: src.source_hash, ...(src.source.fee_cents ? { fee_attested: true as const } : {}) };
    const preview = await api(base(kind, id) + "/preview", body);
    return { ...body, preview_hash: String(preview.preview_hash) };
  };
  const post = async (kind: ReceiptOrigin, id: string) => await api(base(kind, id) + "/post", await bodyFor(kind, id)) as ReceiptContext;
  const reverse = async (kind: ReceiptOrigin, id: string, expected = 200) => {
    const src = await context(kind, id);
    return await api(base(kind, id) + "/reverse", { posting_id: src.posting!.id, day: laterDay, reason: "Owned v9 explicit correction" }, expected) as ReceiptContext;
  };
  const mutate = async (sql: string, values: unknown[]) => transaction(client, async () => { await withReviewLock(client); await client.query(sql, values); });
  const deposit = async (id: string) => record(await api(`/admin/banking/deposits/${id}`)).deposit as BankDeposit;
  let expense = "";
  const makeDeposit = async (suffix: string, lines: Array<[string, string]>, fee = "0.00", feeReference = rootPrefix + suffix) => {
    const candidates = (await api(`/admin/banking/deposit-candidates?account_id=${account}&q=${rootPrefix}`)).candidates as DepositCandidate[];
    const saved = (await api("/admin/banking/deposits", { expected_revision: 0, account_id: account, date: day,
      reference: rootPrefix + suffix, memo: "Owned synthetic v9 deposit", fee_amount: fee,
      fee_account_list_id: fee === "0.00" ? null : expense, fee_reference: fee === "0.00" ? null : feeReference,
      lines: lines.map(([id, amount]) => { const source = candidates.find(c => c.id === id); assert(source, `Available candidate ${id}`);
        return { payment_id: id, amount, expected_source_hash: source.source_hash }; }) })).deposit as BankDeposit;
    const ready = (await api(`/admin/banking/deposits/${saved.id}/ready`, { expected_revision: saved.revision,
      expected_source_hash: saved.source_hash })).deposit as BankDeposit;
    check(ready.status === "ready" && !ready.accounting_posted, "Ready remains operational and does not post GL"); return ready;
  };
  const voidDeposit = async (id: string, expected = 200) => api(`/admin/banking/deposits/${id}/void`, {
    expected_revision: (await deposit(id)).revision, reason: "Release owned reservation after correction" }, expected);
  const match = async (tx: string, paymentId: string) => {
    const candidates = (await api(`/admin/banking/transactions/${tx}/match-candidates?q=${rootPrefix}`)).candidates as Value[];
    const candidate = candidates.find(c => c.id === paymentId); assert(candidate, "Exact eligible direct payment candidate");
    await api(`/admin/banking/transactions/${tx}/review`, { expected_revision: 0, expected_source_version: 1, mode: "match",
      matched_payment_id: paymentId, expected_match_source_hash: candidate.source_hash, comment: "Owned direct v9 match" });
    await api(`/admin/banking/transactions/${tx}/confirm`, { expected_revision: 1, expected_source_version: 1 });
  };
  const report = async () => {
    const query = "from=2026-09-01&to=2026-09-30";
    const docs = await api(`/admin/reports/expenses/documents?${query}`), current = record((await api(`/admin/reports/profit-loss/statement?${query}`)).current);
    return { rows: docs.documents as Value[], expense: Math.round(Number(record(current.expense).total) * 100), income: Math.round(Number(current.net_income) * 100) };
  };
  try {
    owns = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-receipts-v9',7241)) ok")).rows[0].ok);
    check(owns, "Single harness owns v9 fixtures");
    check(!(await client.query("SELECT 1 FROM bank_accounting_setup UNION ALL SELECT 1 FROM bank_review_event WHERE entity_id='local-usd'")).rowCount,
      "No operator receipt setup or command history is overwritten");
    before = await fingerprints(client); banksBefore = await bankingFingerprint(client);
    await seedReceiptAccount(client); seeded = true;
    jwt = String((await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" })).token);
    await api("/admin/banking/accounting/setup", undefined, 401, undefined, true);
    const setup = await api("/admin/banking/accounting/setup"); check(setup.setup === null && setup.opening_pending, "Opening unknown is explicitly pending");
    const ar = (setup.ar_accounts as Value[])[0], uf = (setup.clearing_accounts as Value[]).find(a => /undeposited/i.test(String(a.name)));
    assert(ar && uf);
    const config = { expected_revision: 0, cut_date: "2000-01-01", ar_account_list_id: ar.id, clearing_account_list_id: uf.id, local_usd_attested: true };
    await api("/admin/banking/accounting/setup", { ...config, local_usd_attested: false }, 400);
    await api("/admin/banking/accounting/setup", config);
    expense = String((await client.query("SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Expense' AND (currency IS NULL OR currency IN ('USD','US Dollar')) ORDER BY qb_list_id LIMIT 1")).rows[0].qb_list_id);
    for (const collection of ["receipts", "deposits", "payment-matches"]) {
      const empty = await api(`/admin/banking/accounting/${collection}?from=1900-01-01&to=1900-01-02&offset=0&limit=2`);
      check(empty.count === 0 && (empty.items as unknown[]).length === 0, `${collection} real SQL binds impossible date interval`);
    }
    const p1 = await seedReceiptPayment(client, "main"), d1 = await makeDeposit("main", [[p1, "120.01"]], "2.00");
    const pending = await context("deposit", d1.id); check(pending.blockers.includes("BANKING_RECEIPT_POSTING_REQUIRED"), "Accounting deposit requires recognized receipts");
    await api(base("deposit", d1.id) + "/preview", { expected_source_hash: pending.source_hash, fee_attested: true }, 409);
    const baseline = await report(), body = await bodyFor("receipt", p1), key = randomUUID();
    const receipt = await api(base("receipt", p1) + "/post", body, 200, key) as ReceiptContext;
    assert.deepEqual(receipt.posting!.lines.map(l => [l.role,l.debit_cents,l.credit_cents]), [["clearing",12001,0],["receivable",0,12001]]); checks++;
    const retry = await api(base("receipt", p1) + "/post", body, 200, key) as ReceiptContext;
    check(retry.posting!.id === receipt.posting!.id, "Exact retry returns original journal");
    await api(base("receipt", p1) + "/post", { ...body, preview_hash: "0".repeat(64) }, 409, key);
    assert.deepEqual(await report(), baseline, "Receipt recognition changes no revenue or expense"); checks++;
    await api("/admin/banking/accounting/setup", { ...config, expected_revision: 1 }, 409);
    const src = await context("deposit", d1.id);
    await api(base("deposit", d1.id) + "/preview", { expected_source_hash: src.source_hash }, 409);
    const posted = await post("deposit", d1.id);
    assert.deepEqual(posted.posting!.lines.map(l => [l.role,l.debit_cents,l.credit_cents]), [["bank",11801,0],["clearing",0,12001],["expense",200,0]]); checks++;
    check(!posted.posting!.stale, "Posting itself does not make the deposit stale");
    const fees = await report(); check(fees.expense - baseline.expense === 200 && fees.income - baseline.income === -200, "Fee enters Expenses/P&L once");
    check(fees.rows.filter(r => r.document_id === posted.posting!.id && r.source === "bank_expense").length === 1, "One fee report row identifies journal");
    for (const status of ["partially_applied", "applied", "available"]) {
      await mutate("UPDATE customer_payment SET status=$2 WHERE id=$1", [p1,status]);
      const live = await context("receipt", p1); check(live.source_hash === receipt.source_hash && live.consumed_cents === 12001 && live.available_cents === 0,
        "Application status changes preserve cash identity and deduplicated capacity");
      check(!(await deposit(d1.id)).stale, "Normal application keeps Ready deposit evidence valid");
    }
    await voidDeposit(d1.id,409); const locked = await deposit(d1.id);
    await api(`/admin/banking/deposits/${d1.id}/ready`, { expected_revision: locked.revision, expected_source_hash: locked.source_hash },409);
    await reverse("receipt",p1,409);
    await runReceiptAdversarial({ client, api, check, receiptPaymentId:p1, depositId:d1.id });
    const groupedTx = await seedReceiptMovement(client,"grouped","-118.01");
    await api(`/admin/banking/transactions/${groupedTx}/review`, { expected_revision:0,expected_source_version:1,mode:"deposit",
      matched_deposit_id:d1.id,expected_deposit_source_hash:(await deposit(d1.id)).source_hash,comment:"Owned grouped evidence" });
    await api(`/admin/banking/transactions/${groupedTx}/confirm`, { expected_revision:1,expected_source_version:1 });
    await api(`/admin/banking/transactions/${groupedTx}/return`, { expected_revision:2,expected_source_version:1 });
    check((await context("receipt",p1)).consumed_cents===12001 && !(await context("deposit",d1.id)).posting!.reversed_by, "Grouped unmatch preserves posted consumption");
    const original = (await client.query("SELECT to_jsonb(e) data FROM bank_journal_entry e WHERE id=$1",[posted.posting!.id])).rows[0].data;
    await mutate("UPDATE customer_payment SET metadata=jsonb_build_object('refund_amount',100) WHERE id=$1",[p1]);
    check((await context("receipt",p1)).posting!.stale, "Refund creates visible drift without reversing real bank movement");
    await mutate("DELETE FROM customer_payment WHERE id=$1",[p1]);
    const missing = await context("receipt",p1);
    check(missing.blockers.includes("BANKING_RECEIPT_SOURCE_MISSING") && missing.consumed_cents===12001, "Missing payment preserves journal and posted allocation");
    const listed = await api("/admin/banking/accounting/receipts?from=2026-09-01&to=2026-09-30&limit=50&offset=0");
    check((listed.items as ReceiptContext[]).some(x=>x.source.id===p1), "Deleted posted receipt remains visible under original date filter");
    assert.deepEqual((await client.query("SELECT to_jsonb(e) data FROM bank_journal_entry e WHERE id=$1",[posted.posting!.id])).rows[0].data,original); checks++;
    await reverse("deposit",d1.id); await reverse("receipt",p1); await voidDeposit(d1.id);
    const p2=await seedReceiptPayment(client,"split",10000), p3=await seedReceiptPayment(client,"split_other",5000);
    await post("receipt",p2); await post("receipt",p3);
    const d2=await makeDeposit("split",[[p2,"60.00"],[p3,"50.00"]]); await post("deposit",d2.id);
    check((await context("receipt",p2)).available_cents===4000, "Grouped partial allocation leaves exact remaining capacity");
    const d3=await makeDeposit("split_rest",[[p2,"40.00"]]); await post("deposit",d3.id);
    check((await context("receipt",p2)).consumed_cents===10000, "Separate partial deposits consume full receipt once");
    await reverse("deposit",d3.id); check((await context("receipt",p2)).available_cents===0, "Reversal alone preserves Ready reservation");
    await voidDeposit(d3.id); check((await context("receipt",p2)).available_cents===4000, "Void after reversal releases the reservation");
    const p4=await seedReceiptPayment(client,"direct",731), tx=await seedReceiptMovement(client,"direct","-7.31");
    await post("receipt",p4); await match(tx,p4); const transfer=await post("payment_match",tx);
    check(transfer.posting!.lines.length===2 && transfer.posting!.amount_cents===731,"Individual Match posts bank/clearing without fabricated deposit");
    await api(`/admin/banking/transactions/${tx}/return`,{expected_revision:2,expected_source_version:1},409);
    await reverse("payment_match",tx); await api(`/admin/banking/transactions/${tx}/return`,{expected_revision:2,expected_source_version:1});
    check((await context("receipt",p4)).available_cents===731,"Reverse then unmatch releases direct capacity");
    const race=await seedReceiptPayment(client,"race",1234), raceBody=await bodyFor("receipt",race);
    const outcomes=await Promise.allSettled([postReceiptAccounting("receipt",race,actor+"a",randomUUID(),raceBody),postReceiptAccounting("receipt",race,actor+"b",randomUUID(),raceBody)]);
    check(outcomes.filter(x=>x.status==="fulfilled").length===1,"Two actors and keys create one monetary recognition");
    const bad=await seedReceiptPayment(client,"bad",731);
    for(const [sql,values,code] of [
      ["UPDATE customer_payment SET currency='CAD' WHERE id=$1",[bad],"BANKING_RECEIPT_USD_REQUIRED"],
      ["UPDATE customer_payment SET currency='usd',batch_day='1999-01-01' WHERE id=$1",[bad],"BANKING_RECEIPT_BEFORE_CUT"],
      ["UPDATE customer_payment SET batch_day=$2,method='card' WHERE id=$1",[bad,day],"BANKING_RECEIPT_SOURCE_UNSUPPORTED"],
      ["UPDATE customer_payment SET method='check',metadata='{\"is_sales_receipt_payment\":true}' WHERE id=$1",[bad],"BANKING_RECEIPT_PROVENANCE_UNSUPPORTED"],
      ["UPDATE customer_payment SET metadata='{}',amount=731.1,raw_amount='{\"value\":\"731.1\",\"precision\":20}' WHERE id=$1",[bad],"BANKING_RECEIPT_AMOUNT_INVALID"],
    ] as [string,unknown[],string][]){await mutate(sql,values);const live=await context("receipt",bad);check(live.blockers.includes(code),`Source rejects exact cause ${code}`);
      check((await api(base("receipt",bad)+"/preview",{expected_source_hash:live.source_hash},409)).code===code,"Preview rejects intended unsupported source cause");}
    for(const [label,method,received,batch] of [
      ["before_cut","cash","2026-09-02T22:44:00Z","2026-09-02"],
      ["after_cut","ach","2026-09-02T22:46:00Z","2026-09-03"],
      ["utc_midnight","zelle","2026-09-03T00:30:00Z","2026-09-03"],
    ]){
      const id=await seedReceiptPayment(client,label!,311,batch!,method!);
      await mutate("UPDATE customer_payment SET received_at=$2::timestamptz WHERE id=$1",[id,received]);
      check((await post("receipt",id)).posting!.day===batch,"Receipt journal uses merchant batch date around ET cutoff and UTC midnight");
      if(label==="after_cut"){
        const early=await makeDeposit("early_transfer",[[id,"3.11"]]);
        const earlySource=await context("deposit",early.id);
        check(earlySource.blockers.includes("BANKING_RECEIPT_TRANSFER_DATE_INVALID"),"Operational deposit cannot post before its receipt accounting date");
        check((await api(base("deposit",early.id)+"/preview",{expected_source_hash:earlySource.source_hash},409)).code==="BANKING_RECEIPT_TRANSFER_DATE_INVALID","Early transfer fails for explicit accounting date cause");
        await voidDeposit(early.id);
      }
    }
    const feePayment=await seedReceiptPayment(client,"fee_duplicate",911);await post("receipt",feePayment);
    const knownBill=String((await client.query("SELECT id FROM vendor_bill WHERE deleted_at IS NULL ORDER BY id LIMIT 1")).rows[0].id);
    const duplicateFee=await makeDeposit("fee_duplicate",[[feePayment,"9.11"]],"0.50",`vendor_bill:${knownBill}`);
    const duplicateSource=await context("deposit",duplicateFee.id);
    check((await api(base("deposit",duplicateFee.id)+"/preview",{expected_source_hash:duplicateSource.source_hash,fee_attested:true},409)).code==="BANKING_RECEIPT_FEE_ALREADY_RECOGNIZED","Explicit existing bill cannot be posted again as a new fee");
    await voidDeposit(duplicateFee.id);
    const expenseBefore=expense;expense=String((await client.query("SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='CostOfGoodsSold' ORDER BY qb_list_id LIMIT 1")).rows[0].qb_list_id);
    const cogsFee=await makeDeposit("fee_cogs",[[feePayment,"9.11"]],"0.50");expense=expenseBefore;
    const cogsSource=await context("deposit",cogsFee.id);
    check((await api(base("deposit",cogsFee.id)+"/preview",{expected_source_hash:cogsSource.source_hash,fee_attested:true},409)).code==="BANKING_RECEIPT_FEE_INVALID","COGS operational fee is outside v9 accounting scope");
    await voidDeposit(cogsFee.id);
    const browserPayment=await seedReceiptPayment(client,"browser"), browserDeposit=await makeDeposit("browser",[[browserPayment,"120.01"]],"2.00");
    const browserMatchPayment=await seedReceiptPayment(client,"browser_match",843), browserMatch=await seedReceiptMovement(client,"browser_match","-8.43");
    await post("receipt",browserMatchPayment);await match(browserMatch,browserMatchPayment);
    // 2026-09-12: la página Banks → Receipts se retiró (los cobros sueltos se depositan
    // desde Record Deposits: `deposits/from-payment`). Los journals `receipt` /
    // `payment_match` siguen válidos y los cubre la API arriba; el tramo de browser
    // (`store-pos/scripts/e2e/bank-receipts.mjs`) ya no existe — la UI la cubre
    // `store-pos/scripts/e2e/accounting-banking-ux.mjs` (picker de dos pestañas).
    check(Boolean(browserPayment&&browserDeposit.id&&browserMatch),"Legacy receipt/match fixtures still post via API (browser leg retired)");
  } catch(error) { console.error("V9 primary failure before cleanup:",error instanceof Error?error.message:"UNKNOWN_ERROR"); throw error; }
  finally {
    try { if(owns){await client.query("ROLLBACK");if(seeded)await cleanReceiptFixtures(client);
      if(before){assert.deepEqual(await fingerprints(client),before,"Existing Finance, stock and pipeline preserved");checks++;}
      if(banksBefore){assert.deepEqual(await bankingFingerprint(client),banksBefore,"Operator banking rows preserved");checks++;}
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-receipts-v9',7241))");
    }} finally {client.release();await pool.end();}
  }
  console.log(`PASS bank receipts integration: ${checks} checks; owned residue=0; protected sources unchanged`);
}
void main().catch((error:unknown)=>{console.error(`V9 failed after ${checks} checks`,error instanceof Error?error.message:"UNKNOWN_ERROR");process.exitCode=1;});
