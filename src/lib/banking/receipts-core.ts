import type { PoolClient } from "pg";
import { acquireBankAccountingPeriodLock, assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { BankingError } from "./security";
import { bankId } from "./store";
import { appendReviewEvent, reviewCapacity, reviewHash, runReviewCommand } from "./review-common";
import { reviewToday } from "./review-date";
import { receiptRead } from "./receipts-setup";
import { receiptContext, receiptEvidence, receiptHistory } from "./receipts-read";
import { receiptPostSchema, receiptPreviewSchema, receiptReverseSchema, type ReceiptLine, type ReceiptOrigin,
  type ReceiptPostInput, type ReceiptPreview, type ReceiptReverseInput } from "./receipts-types";

async function buildReceiptPreview(client: PoolClient, kind: ReceiptOrigin, id: string, expectedHash: string, feeAttested?: true) {
  const evidence = await receiptEvidence(client, kind, id);
  if (evidence.blockers.length) throw new BankingError(evidence.blockers[0]!, 409);
  if (evidence.source_hash !== expectedHash) throw new BankingError("BANKING_RECEIPT_SOURCE_STALE", 409);
  if (evidence.source.fee_cents > 0 && feeAttested !== true) throw new BankingError("BANKING_RECEIPT_FEE_ATTESTATION_REQUIRED", 409);
  const history = await receiptHistory(client, kind, id, evidence.source_hash);
  if (history.some(e => e.kind === kind && !e.reversed_by)) throw new BankingError("BANKING_ALREADY_POSTED", 409);
  await acquireBankAccountingPeriodLock(client, evidence.source.day);
  await assertBankAccountingPeriodOpen(client, evidence.source.day);
  const preview: ReceiptPreview = { source_hash: evidence.source_hash, day: evidence.source.day,
    amount_cents: evidence.source.amount_cents!, lines: evidence.lines, blockers: [], opening_pending: true, coverage: "partial",
    preview_hash: reviewHash({ source_hash: evidence.source_hash, lines: evidence.lines, fee_attested: feeAttested ?? false,
      history: history.map(e => e.id) }) };
  return { evidence, preview };
}
export async function previewReceiptAccounting(kind: ReceiptOrigin, id: string, input: { expected_source_hash: string; fee_attested?: true }) {
  const body = receiptPreviewSchema.parse(input);
  return receiptRead(async client => (await buildReceiptPreview(client, kind, id, body.expected_source_hash, body.fee_attested)).preview);
}
async function insertReceiptLines(client: PoolClient, entryId: string, lines: ReceiptLine[]) {
  for (const line of lines) {
    await reviewCapacity(client, "bank_journal_line", 4000);
    await client.query(`INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [bankId("bjl"), entryId, line.role, line.account_list_id,
      JSON.stringify(line.account_snapshot), line.debit_cents, line.credit_cents]);
  }
}
export async function postReceiptAccounting(kind: ReceiptOrigin, id: string, actorId: string, key: string, input: ReceiptPostInput) {
  const body = receiptPostSchema.parse(input);
  return runReviewCommand({ actorId, key, operation: `receipt_${kind}_post`, entityId: id, body }, async client => {
    const { evidence, preview } = await buildReceiptPreview(client, kind, id, body.expected_source_hash, body.fee_attested);
    if (preview.preview_hash !== body.preview_hash) throw new BankingError("BANKING_RECEIPT_PREVIEW_STALE", 409);
    let receiptId: string | null = null;
    if (kind === "receipt") {
      const existing = (await client.query<{ id: string }>("SELECT id FROM bank_receipt_accounting WHERE payment_id=$1", [id])).rows[0];
      receiptId = existing?.id ?? bankId("bra");
      if (!existing) {
        await reviewCapacity(client, "bank_receipt_accounting", 200);
        await client.query("INSERT INTO bank_receipt_accounting(id,payment_id,setup_id) VALUES($1,$2,'local-usd')", [receiptId, id]);
      }
    }
    await reviewCapacity(client, "bank_journal_entry", 1000);
    const entryId = bankId("bje");
    await client.query(`INSERT INTO bank_journal_entry(id,receipt_id,deposit_id,transaction_id,kind,day,currency,amount_cents,
      source_hash,source_snapshot,reference,description,actor_id) VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9::jsonb,$10,$11,$12)`,
    [entryId, receiptId, kind === "deposit" ? id : null, kind === "payment_match" ? id : null, kind, preview.day,
      preview.amount_cents, evidence.source_hash, JSON.stringify({ ...evidence.snapshot, fee_attested: body.fee_attested ?? false }),
      evidence.source.reference, evidence.source.name, actorId]);
    await insertReceiptLines(client, entryId, preview.lines);
    for (const allocation of evidence.allocations) {
      await reviewCapacity(client, "bank_receipt_consumption", 2000);
      await client.query(`INSERT INTO bank_receipt_consumption(id,entry_id,receipt_id,payment_id,opening_item_id,amount_cents,origin_kind,origin_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [bankId("brc"), entryId, allocation.receipt_id, allocation.payment_id,
        allocation.opening_item_id ?? null, allocation.amount_cents, kind, id]);
    }
    await appendReviewEvent(client, { entity_type: "receipt_accounting", entity_id: id, action: `${kind}_posted`, actor_id: actorId,
      transaction_id: kind === "payment_match" ? id : null, details: { entry_id: entryId, preview_hash: preview.preview_hash } });
    return receiptContext(client, kind, id);
  });
}
type Original = { id: string; kind: ReceiptOrigin; day: string; receipt_id: string | null; deposit_id: string | null;
  transaction_id: string | null; amount_cents: string; source_hash: string; source_snapshot: unknown; reference: string; description: string };
export async function reverseReceiptAccounting(kind: ReceiptOrigin, id: string, actorId: string, key: string, input: ReceiptReverseInput) {
  const body = receiptReverseSchema.parse(input);
  return runReviewCommand({ actorId, key, operation: `receipt_${kind}_reverse`, entityId: id, body }, async client => {
    // Reversal uses immutable history, so corrupt or removed live evidence cannot hide the correction path.
    const history = await receiptHistory(client, kind, id, "");
    const active = history.find(e => e.id === body.posting_id && e.kind === kind && !e.reversed_by);
    if (!active) throw new BankingError("BANKING_RECEIPT_POSTING_NOT_ACTIVE", 409);
    if (body.day < active.day || body.day > reviewToday()) throw new BankingError("BANKING_RECEIPT_REVERSAL_DATE_INVALID", 409);
    const original = (await client.query<Original>("SELECT * FROM bank_journal_entry WHERE id=$1", [active.id])).rows[0]!;
    if (kind === "receipt") {
      const consumed = await client.query(`SELECT id FROM bank_receipt_consumption c WHERE receipt_id=$1
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id) LIMIT 1`, [original.receipt_id]);
      if (consumed.rowCount) throw new BankingError("BANKING_RECEIPT_CONSUMED", 409);
    }
    await acquireBankAccountingPeriodLock(client, body.day);
    await assertBankAccountingPeriodOpen(client, body.day);
    await reviewCapacity(client, "bank_journal_entry", 1000);
    const entryId = bankId("bje");
    await client.query(`INSERT INTO bank_journal_entry(id,receipt_id,deposit_id,transaction_id,kind,day,currency,amount_cents,
      source_hash,source_snapshot,reference,description,actor_id,reverses_entry_id,reason)
      VALUES($1,$2,$3,$4,'reversal',$5,'USD',$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
    [entryId, original.receipt_id, original.deposit_id, original.transaction_id, body.day, original.amount_cents,
      original.source_hash, JSON.stringify(original.source_snapshot), original.reference, original.description, actorId, active.id, body.reason]);
    await insertReceiptLines(client, entryId, active.lines.map(l => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents })));
    await appendReviewEvent(client, { entity_type: "receipt_accounting", entity_id: id, action: `${kind}_reversed`, actor_id: actorId,
      transaction_id: kind === "payment_match" ? id : null, details: { entry_id: entryId, reverses_entry_id: active.id, day: body.day, reason: body.reason } });
    return receiptContext(client, kind, id);
  });
}
