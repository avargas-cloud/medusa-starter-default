/**
 * Case 09 · Individual match of the +500.00 credit ("EPT deposit test") with an ACH customer receipt.
 * Own fixtures (prefix cpay_btx_review_*): the $500 ACH for BRINZI CORP persists; two CONTROL receipts
 * (card $500, ACH $499.99) prove the candidate filter and are removed at the end.
 * The receipt itself is never modified by the match.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

const CUSTOMER = "cus_01KG0Q2TGEMR410KKTCFNFYZJY"; // BRINZI CORP (real customer with Zelle/check history)
const MAIN = "cpay_btx_review_case09_ach500";
const CONTROLS: Array<[string, string, number]> = [["cpay_btx_review_case09_card500", "credit_card", 50000], ["cpay_btx_review_case09_ach49999", "ach", 49999]];

void run("case-09", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).deposit!;
  assert.equal(tx.amount, "500", "the credit shows +500 in the UI");
  const insert = async (id: string, method: string, cents: number, reference: string) => pool.query(
    `INSERT INTO customer_payment (id,customer_id,source,type,amount,currency,method,reference,status,received_at,batch_day,
       raw_amount,notes,created_by,created_at,updated_at,medusa_payment_synced,display_id)
     VALUES ($1,$2,'pos','payment',$3::numeric,'usd',$4,$5,'available','2026-09-03 14:00:00+00','2026-09-03',
       jsonb_build_object('value',$3::numeric::text,'precision',20),'Fixture revisión guiada Banking · caso 09','bank-review',now(),now(),false,(SELECT max(display_id)+1 FROM customer_payment))
     ON CONFLICT (id) DO NOTHING`, [id, CUSTOMER, cents, method, reference]);
  await insert(MAIN, "ach", 50000, "CASO09 ACH 500");
  for (const [id, method, cents] of CONTROLS) await insert(id, method, cents, `CASO09 control ${method} ${cents}`);
  const receiptBefore = (await pool.query("SELECT amount,status,method,updated_at,customer_id FROM customer_payment WHERE id=$1", [MAIN])).rows[0];

  const candidates = await api.get(`/admin/banking/transactions/${tx.id}/match-candidates`);
  const offered = (candidates.candidates as Json[]) ?? (candidates.payments as Json[]) ?? [];
  const main = offered.find(c => c.id === MAIN);
  assert(main, "the exact ACH $500 is offered");
  assert(!offered.some(c => CONTROLS.map(x => x[0]).includes(String(c.id))), "card $500 and ACH $499.99 are NOT offered");

  let review: Json = record(tx.review) ?? {};
  if (review.matched_payment_id !== MAIN) {
    review = record((await api.post(`/admin/banking/transactions/${tx.id}/review`, {
      mode: "match", matched_payment_id: MAIN, expected_match_source_hash: main.source_hash, comment: "Caso 09 · match ACH 500 BRINZI CORP",
      expected_revision: Number(review.revision ?? 0), expected_source_version: Number(tx.source_version) }, { "Idempotency-Key": `case-09-${randomUUID()}` })).review) ?? {};
  }
  const wrongHash = await api.call(`/admin/banking/transactions/${tx.id}/review`, { method: "POST", allow: [409], headers: { "Idempotency-Key": `case-09-${randomUUID()}` },
    body: { mode: "match", matched_payment_id: MAIN, expected_match_source_hash: "0".repeat(32), comment: "x", expected_revision: Number(review.revision), expected_source_version: Number(tx.source_version) } });
  const row = (await baseAccount(api, pool)).deposit!;
  const receiptAfter = (await pool.query("SELECT amount,status,method,updated_at,customer_id FROM customer_payment WHERE id=$1", [MAIN])).rows[0];
  const utilitiesCandidates = await api.get(`/admin/banking/transactions/${(await baseAccount(api, pool)).utilities!.id}/match-candidates`);
  await pool.query("DELETE FROM customer_payment WHERE id=ANY($1)", [CONTROLS.map(x => x[0])]);

  assert.equal(review.mode, "match"); assert.equal(review.matched_payment_id, MAIN);
  assert.equal(review.counterparty_type, "customer"); assert.equal(review.counterparty_name, "BRINZI CORP");
  assert.equal(wrongHash.status, 409, "a stale/wrong receipt hash cannot match");
  assert.deepEqual(receiptAfter, receiptBefore, "the receipt is not modified by the match");
  assert.equal(row.review_status, "pending", "matched but not confirmed yet");
  assert.equal(await journalCount(pool), 0);

  block("Qué hice", { transaction_id: tx.id, movement: `${tx.date} ${tx.name} +${tx.amount}`, fixtures: { main: { id: MAIN, customer: "BRINZI CORP", method: "ach", amount: "500.00", batch_day: "2026-09-03", persists: true }, controls: CONTROLS.map(c => ({ id: c[0], method: c[1], cents: c[2], removed_at_end: true })) },
    request: { mode: "match", matched_payment_id: MAIN, expected_match_source_hash: main.source_hash } });
  block("Qué esperamos", { candidates_offered: offered.map(c => `${c.display_id ?? c.id} · ${c.customer_name} · ${c.reference}`), review: { status: review.status, mode: review.mode, matched_payment_id: review.matched_payment_id, counterparty: `${review.counterparty_type} · ${review.counterparty_name}`, revision: review.revision },
    wrong_hash: { status: wrongHash.status, code: wrongHash.body.code }, receipt_unchanged: receiptAfter, debit_has_no_candidates: (utilitiesCandidates.candidates as Json[] ?? []).length === 0, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → fila 2026-09-03 EPT deposit test · Match / Category muestra el cobro ACH de BRINZI CORP y From/To = BRINZI CORP (automático); sigue en To review");
});
