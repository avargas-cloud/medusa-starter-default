/** Orderless synthetic sources; the orchestrator runs suites sequentially. */
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { OpeningSandboxApi } from "../../lib/banking/opening-sandbox-api";
import { movementPrefix as prefix,movementActor,seedMovementRefund,cleanMovementFixtures } from "./bank-movements-fixtures";
export async function seedSettlementPayment(client:PoolClient,suffix:string,cents:number,refund=false) {
  const id=await seedMovementRefund(client,`merchant_${suffix}`,cents);
  await transaction(client,async()=>{
    await withReviewLock(client);
    await client.query("UPDATE customer_payment SET method='credit_card',type=$2 WHERE id=$1 AND created_by=$3",
      [id,refund?"refund":"payment",movementActor]);
  });
  return id;
}
export async function settlementEvidence(test:OpeningSandboxApi,suffix:string) {
  const stream=`BT /F1 10 Tf 10 50 Td (${prefix}${suffix}) Tj ET\n`;
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf="%PDF-1.4\n";const offsets=[0];
  for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result=await test.api("/admin/banking/evidence",{name:prefix+suffix+".pdf",mime_type:"application/pdf",content_base64:Buffer.from(pdf).toString("base64")});
  return String((result.evidence as Record<string,unknown>).id);
}
export async function cleanSettlementFixtures(client:PoolClient) {
  await transaction(client,async()=>{
    await withReviewLock(client);
    const headers=(await client.query("SELECT id FROM bank_merchant_settlement WHERE starts_with(reference,$1)",[prefix])).rows.map(r=>String(r.id));
    const entries=(await client.query(`SELECT id FROM bank_journal_entry WHERE completion_id=ANY($1::text[])
      OR starts_with(completion_id,$2)`,[headers,prefix])).rows.map(r=>String(r.id));
    assert(headers.length<=100&&entries.length<=2000);
    const guards=["bank_journal_entry","bank_journal_line","bank_source_claim","bank_merchant_settlement","bank_merchant_settlement_line"];
    const trigger=(table:string)=>table.replace("bank_merchant_settlement","bank_settlement")+"_immutable";
    await client.query(`LOCK TABLE ${guards.join(",")} IN ACCESS EXCLUSIVE MODE`);
    const state=(await client.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname`,[guards.map(trigger)])).rows;
    assert(state.length===guards.length&&state.every(s=>s.tgenabled==="O"));
    for(const table of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger(table)}`);
    await client.query("DELETE FROM bank_source_claim WHERE entry_id=ANY($1::text[])",[entries]);
    await client.query("DELETE FROM bank_journal_line WHERE entry_id=ANY($1::text[])",[entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[]) AND kind='reversal'",[entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[])",[entries]);
    await client.query("DELETE FROM bank_merchant_settlement_line WHERE settlement_id=ANY($1::text[])",[headers]);
    await client.query("DELETE FROM bank_merchant_settlement WHERE id=ANY($1::text[])",[headers]);
    for(const table of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger(table)}`);
    assert.deepEqual((await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname",[guards.map(trigger)])).rows,state);
    await client.query(`DELETE FROM bank_review_event WHERE entity_id=ANY($1::text[]) OR starts_with(entity_id,$2)
      OR result->'settlement'->>'id'=ANY($1::text[])`,[headers,prefix]);
  });
  await cleanMovementFixtures(client);
}
