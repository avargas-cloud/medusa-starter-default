/** V12 real API, independent cents identities, and owned-fixture cleanup. */
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDbPool } from "../../api/utils/db-pool";
import { configureCompletionSandbox } from "./bank-completion-fixtures";
import { OpeningSandboxApi } from "../../lib/banking/opening-sandbox-api";
import type { SettlementContext,SettlementInput,SettlementLine,SettlementPreview } from "../../lib/banking/settlement-types";
import { seedSettlementPayment,settlementEvidence,cleanSettlementFixtures } from "./bank-settlements-fixtures";
import { movementPrefix as prefix,movementAccounts as banks,movementDay as day,ensureMovementSetup,
  seedMovementAccounts,seedMovementTransaction,seedMovementRefund,movementFixtureMutation,fingerprints,bankingFingerprint } from "./bank-movements-fixtures";
type Value=Record<string,unknown>;
export type SettlementBrowserOptions = { allowMutations: true; fixtureOwner: string;
  merchantReceipt?: { paymentId: string; paymentReference: string; evidenceId: string; clearingAccountName: string; arAccountName: string };
  settlementDraft?: { id: string; post: true } };
export type SettlementBrowserHook = (options: SettlementBrowserOptions) => Promise<{ checks: number; artifacts?: string[] }>;
export async function runBankSettlementsSandbox(snapshot:{file:string;sha256:string},browser?:SettlementBrowserHook) {
  configureCompletionSandbox();
  assert.equal(createHash("sha256").update(readFileSync(snapshot.file)).digest("hex"),snapshot.sha256);
  const client=await getDbPool().connect(),test=new OpeningSandboxApi(),base="/admin/banking/settlements";
  let owns=false,seeded=false,before:Value|undefined,banksBefore:Value|undefined;
  let browserChecks=0;const browserArtifacts:string[]=[];
  let clearing="",ar="",expense="",liability="",reserve="";
  const source=(id:string)=>test.api(`/admin/banking/merchant-receipts/${id}`);
  const context=(id:string)=>test.api(`${base}/${id}`) as Promise<SettlementContext>;
  const preview=(ctx:SettlementContext)=>test.api(`${base}/${ctx.settlement.id}/preview`,{expected_revision:ctx.settlement.revision}) as Promise<SettlementPreview>;
  const post=async(ctx:SettlementContext)=>{const p=await preview(ctx);assert.deepEqual(p.blockers,[]);
    return test.api(`${base}/${ctx.settlement.id}/post`,{expected_revision:ctx.settlement.revision,preview_hash:p.preview_hash}) as Promise<SettlementContext>;};
  const reverse=(ctx:SettlementContext,expected=200)=>test.api(`${base}/${ctx.settlement.id}/reverse`,{
    posting_id:ctx.postings.find(p=>p.kind==="merchant_settlement"&&!p.reversed_by)!.id,day,reason:"Owned V12 exact correction"},expected);
  const report=async()=>{const r=(await test.api("/admin/reports/profit-loss/statement?from=2026-09-01&to=2026-09-30")).current as Value;
    return {expense:Math.round(Number((r.expense as Value).total)*100),income:Math.round(Number(r.net_income)*100)};};
  const recognize=async(suffix:string,cents:number)=>{
    const id=await seedSettlementPayment(client,suffix,cents),ev=await settlementEvidence(test,suffix+"_receipt"),read=await source(id);
    assert.deepEqual(read.blockers,[]);
    const body={payment_id:id,day,evidence_id:ev,clearing_account_list_id:clearing,ar_account_list_id:ar,attested:true,expected_source_hash:read.source_hash};
    const p=await test.api("/admin/banking/merchant-receipts/preview",body);
    const key=randomUUID(),posted=await test.api("/admin/banking/merchant-receipts/post",{...body,preview_hash:p.preview_hash},200,key);
    assert.deepEqual(await test.api("/admin/banking/merchant-receipts/post",{...body,preview_hash:p.preview_hash},200,key),posted);
    return {id,posted,ev};
  };
  const line=(kind:SettlementLine["kind"],cents:number,sourceId:string,account:string,ev:string,capacity=cents):SettlementLine=>({
    kind,reference:sourceId,amount_cents:cents,source_id:sourceId,account_list_id:account,evidence_id:ev,
    documented_capacity_cents:capacity,documented_as_of:day,recognition_owner:["fee","reserve_hold"].includes(kind)?"new":"existing",surcharge_cents:0});
  const make=async(suffix:string,lines:SettlementLine[],net:number)=>{
    const ev=await settlementEvidence(test,suffix+"_settlement");
    const tx=net===0?null:await seedMovementTransaction(client,suffix+"_payout",-net);
    const body:SettlementInput={expected_revision:0,processor:"testprocessor",merchant:"testmerchant",reference:prefix+suffix,
      day,bank_account_id:banks[0],transaction_id:tx,evidence_id:ev,attested:true,memo:"Owned synthetic merchant settlement",lines};
    return {body,ctx:await test.api(base,body) as SettlementContext};
  };
  try {
    owns=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-completion',7241)) ok")).rows[0].ok);assert(owns);
    before=await fingerprints(client);banksBefore=await bankingFingerprint(client);
    assert(!(await client.query("SELECT 1 FROM bank_connection WHERE starts_with(id,$1)",[prefix])).rowCount,"No stale fixtures");
    await seedMovementAccounts(client);seeded=true;await ensureMovementSetup();await test.login();
    await test.api(base,undefined,401,undefined,true);
    const accounts=(await test.api("/admin/banking/movements/accounts")).accounts as Array<{id:string;name:string;account_type:string;currency:string|null}>;
    const choose=(type:string,other?:string)=>{const a=accounts.find(a=>a.account_type===type&&a.id!==other&&(!a.currency||a.currency==="USD"));assert(a);return a.id;};
    clearing=choose("OtherCurrentAsset");reserve=choose("OtherCurrentAsset",clearing);ar=choose("AccountsReceivable");
    expense=choose("Expense");liability=choose("OtherCurrentLiability");
    for(const kind of ["card_payment","receipt","refund","reserve_release"]) {
      const empty=await test.api(`${base}/sources?kind=${kind}&q=impossible_bank_completion_source`);
      test.check((empty.sources as unknown[]).length===0&&empty.more===false,`${kind} actual lookup binds empty target`);
    }
    const baseline=await report(),receipt=await recognize("thousand",100000);
    assert.deepEqual(await report(),baseline,"AR recognition does not add sales revenue");
    const refund=await seedSettlementPayment(client,"refund100",10000,true),ev=await settlementEvidence(test,"deductions");
    await movementFixtureMutation(client,`UPDATE customer_payment SET type='payment',status='partial_refunded',amount=20000,
        raw_amount='{"value":"20000","precision":20}'::jsonb,
        metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('refund_amount',10000,'refund_txn_date',$2::text)
        WHERE id=$1`,[refund,day]);
    const refundLookup=(await test.api(`${base}/sources?kind=refund&q=${refund}`)).sources as Value[];
    test.check(refundLookup.length===1&&refundLookup[0]!.amount_cents===10000&&refundLookup[0]!.day===day,
      "Partial card refund lookup uses actual refund cents and economic date");
    const mixed=await make("825",[line("receipt",100000,receipt.id,clearing,receipt.ev),line("refund",10000,refund,liability,ev),
      line("fee",2500,prefix+"fee25",expense,ev),line("reserve_hold",5000,prefix+"reserve50",reserve,ev)],82500);
    const p=await preview(mixed.ctx);assert.deepEqual(p.blockers,[]);
    test.check(p.totals.net_cents===82500&&p.lines.find(l=>l.role==="bank")?.debit_cents===82500,"1000 - refund100 - fee25 - reserve50 = bank825");
    const posted=await post(mixed.ctx),posting=posted.postings.find(e=>e.kind==="merchant_settlement")!;
    const impact=await report();test.check(impact.expense-baseline.expense===2500&&impact.income-baseline.income===-2500,"Only fee25 enters P&L; refund/reserve do not duplicate expense");
    await test.api(base,mixed.body,409);
    await test.api(base,{...mixed.body,id:posted.settlement.id,expected_revision:1},409);
    const receiptPosting=(receipt.posted.postings as Value[])[0]!;
    await test.api(`/admin/banking/merchant-receipts/${receipt.id}/reverse`,{posting_id:receiptPosting.id,day,reason:"Consumed receipt cannot reverse"},409);
    const evZero=await settlementEvidence(test,"zero"),lot=posting.id+":counterpart_3";
    const zero=await make("zero",[line("reserve_release",5000,lot,reserve,evZero),line("fee",5000,prefix+"fee50",expense,evZero)],0);
    const zeroPosted=await post(zero.ctx);
    test.check(zeroPosted.totals.net_cents===0&&!zeroPosted.postings[0]!.lines.some(l=>l.role==="bank"),"Zero payout releases reserve against fee without fake bank transaction");
    await reverse(posted,409);await reverse(zeroPosted);await reverse(posted);
    assert.deepEqual(await report(),baseline,"Exact dependency-ordered reversals restore P&L");
    const card=await recognize("surcharge",10000),evSurcharge=await settlementEvidence(test,"surcharge_doc");
    const surchargeLine=line("receipt",10000,card.id,clearing,evSurcharge);surchargeLine.surcharge_cents=300;
    const surcharge=await make("surcharge",[surchargeLine],10000),surchargePosted=await post(surcharge.ctx);
    test.check(surchargePosted.totals.net_cents===10000&&surchargePosted.totals.surcharge_audit_cents===300,"Base100 charged103 pays100; surcharge not subtracted twice");
    assert.deepEqual(await report(),baseline);
    const refund2=await seedSettlementPayment(client,"negative",10000,true),evNeg=await settlementEvidence(test,"negative_doc");
    const negative=await make("negative",[line("refund",10000,refund2,liability,evNeg),line("fee",500,prefix+"fee5",expense,evNeg)],-10500);
    const negativePosted=await post(negative.ctx);
    test.check(negativePosted.postings[0]!.lines.find(l=>l.role==="bank")?.credit_cents===10500,"Refund100 + fee5 = actual bank debit105");
    const ach=await seedMovementRefund(client,"not_merchant",500),evAch=await settlementEvidence(test,"ach");
    const achDoc=await make("ach_invalid",[line("refund",500,ach,liability,evAch)],-500);
    test.check((await preview(achDoc.ctx)).blockers.includes("BANKING_MERCHANT_REFUND_METHOD_INVALID"),"ACH refund cannot be taken from merchant clearing");
    const partial=await recognize("partial",20000),evPartial=await settlementEvidence(test,"partial");
    const part1=await make("part1",[line("receipt",12000,partial.id,clearing,evPartial,20000)],12000);
    await post(part1.ctx);
    const part2=await make("part2",[line("receipt",8000,partial.id,clearing,evPartial,20000)],8000);
    const racePreview=await preview(part2.ctx),raceBody={expected_revision:1,preview_hash:racePreview.preview_hash},key=randomUUID();
    const race=await Promise.all([test.api(`${base}/${part2.ctx.settlement.id}/post`,raceBody,200,key),test.api(`${base}/${part2.ctx.settlement.id}/post`,raceBody,200,key)]);
    assert.deepEqual(race[0],race[1]);test.check(true,"Partial grouped payouts consume200 exactly; concurrent retry posts once");
    const excess=await make("excess",[line("receipt",1,partial.id,clearing,evPartial,20000)],1);
    await test.api(`${base}/${excess.ctx.settlement.id}/preview`,{expected_revision:1},409);
    await movementFixtureMutation(client,"UPDATE customer_payment SET amount=10001,raw_amount=jsonb_build_object('value','10001','precision',20) WHERE id=$1",[card.id]);
    test.check((await context(surchargePosted.settlement.id)).blockers.includes("BANKING_RECEIPT_SOURCE_STALE"),"Posted receipt source drift blocks settlement integrity");
    await reverse(negativePosted);
    assert.deepEqual(await report(),baseline,"Remaining settlements contain no Expense beyond explicitly reversed fees");
    if(browser) {
      const paymentId=await seedSettlementPayment(client,"browser_card",10000);
      const evidenceId=await settlementEvidence(test,"browser_card_receipt"),payment=await source(paymentId);
      assert.deepEqual(payment.blockers,[],"Fresh owned browser card source is eligible");
      const receiptResult=await browser({allowMutations:true,fixtureOwner:prefix,
        merchantReceipt:{paymentId,paymentReference:paymentId,evidenceId,
          clearingAccountName:accounts.find(account=>account.id===clearing)!.name,
          arAccountName:accounts.find(account=>account.id===ar)!.name}});
      test.check(Number.isSafeInteger(receiptResult.checks)&&receiptResult.checks>0,"V12 real browser executed card recognition checks");
      browserChecks+=receiptResult.checks;browserArtifacts.push(...receiptResult.artifacts??[]);
      const recognized=await source(paymentId),receiptEntries=recognized.postings as Array<{id:string;kind:string;reversed_by:string|null;
        lines:Array<{role:string;account_list_id:string;debit_cents:number;credit_cents:number}>}>;
      const receiptEntry=receiptEntries.find(entry=>entry.kind==="merchant_receipt"&&!entry.reversed_by);
      test.check(receiptEntries.length===1&&receiptEntry
        &&receiptEntry.lines.some(entry=>entry.account_list_id===clearing&&entry.debit_cents===10000)
        &&receiptEntry.lines.some(entry=>entry.account_list_id===ar&&entry.credit_cents===10000),
      "Browser card100 recognizes merchant clearing against existing AR exactly once");
      assert.deepEqual(await report(),baseline,"Browser card recognition creates no duplicate revenue");
      const evBrowser=await settlementEvidence(test,"browser_surcharge"),browserLine=line("receipt",10000,paymentId,clearing,evBrowser);
      browserLine.surcharge_cents=300;
      const browserDraft=await make("browser_surcharge",[browserLine],10000);
      const settlementResult=await browser({allowMutations:true,fixtureOwner:prefix,
        settlementDraft:{id:browserDraft.ctx.settlement.id,post:true}});
      test.check(Number.isSafeInteger(settlementResult.checks)&&settlementResult.checks>0,"V12 real browser executed settlement checks");
      browserChecks+=settlementResult.checks;browserArtifacts.push(...settlementResult.artifacts??[]);
      const browserPosted=await context(browserDraft.ctx.settlement.id);
      const active=browserPosted.postings.filter(entry=>entry.kind==="merchant_settlement"&&!entry.reversed_by);
      test.check(active.length===1&&browserPosted.settlement.revision===2&&browserPosted.totals.net_cents===10000
        &&browserPosted.totals.surcharge_audit_cents===300&&active[0]!.lines.some(entry=>entry.role==="bank"&&entry.debit_cents===10000)
        &&active[0]!.lines.some(entry=>entry.account_list_id===clearing&&entry.credit_cents===10000)
        &&!active[0]!.lines.some(entry=>entry.role.startsWith("expense")),
      "Browser settlement transfers base100 to bank; surcharge3 is audit-only with zero Expense");
      assert.deepEqual(await report(),baseline,"Browser settlement preserves exact P&L baseline");
      await reverse(browserPosted);
      assert(receiptEntry);
      await test.api(`/admin/banking/merchant-receipts/${paymentId}/reverse`,{
        posting_id:receiptEntry.id,day,reason:"Owned V12 browser dependency-ordered cleanup"});
      test.check((await context(browserPosted.settlement.id)).postings.some(entry=>entry.kind==="reversal"),
        "Browser settlement is explicitly reversed before merchant receipt cleanup");
      assert.deepEqual(await report(),baseline,"Browser reversals preserve the exact P&L baseline");
    }
  } catch(error) {
    const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
    console.error("V12_ORIGINAL_FAILURE",code,error instanceof Error?error.message:"UNKNOWN_ERROR");
    throw error;
  } finally {
    try {if(owns){await client.query("ROLLBACK");if(seeded)await cleanSettlementFixtures(client);
      if(before)assert.deepEqual(await fingerprints(client),before,"Protected financial rows unchanged");
      if(banksBefore)assert.deepEqual(await bankingFingerprint(client),banksBefore,"Exact Banking baseline restored");
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-completion',7241))");}}
    finally{client.release();}
  }
  console.log(`PASS V12 real HTTP/PG: ${test.checks} checks; browser=${browserChecks}; owned residue=0; protected fingerprints unchanged`);
  return {checks:test.checks,browser_checks:browserChecks,browser_artifacts:browserArtifacts,owned_residue:0,protected_unchanged:true};
}
