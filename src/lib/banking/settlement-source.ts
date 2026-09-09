import type { PoolClient } from "pg";
import { BankingError } from "./security";
import { reviewHash } from "./review-common";
import { paymentReceiptSource } from "./receipts-source";
import { completionEvidence } from "./completion-evidence";
import { movementAllocationFact, normalizeDocumentReference } from "./movement-source";
import { merchantReceiptDrift } from "./merchant-receipts";
import type { CompletionClaim } from "./movement-types";
import type { SettlementLine } from "./settlement-types";

export async function settlementLineFact(client: PoolClient, line: SettlementLine, day: string) {
  const evidence = await completionEvidence(client,line.evidence_id);
  if (line.documented_as_of && line.documented_as_of > day) throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID",409);
  let claims: CompletionClaim[] = [], identity: unknown;
  if (line.kind === "receipt") {
    const current = await paymentReceiptSource(client,line.source_id,"card");
    const blockers = await merchantReceiptDrift(client,line.source_id);
    if (blockers.length) throw new BankingError(blockers[0]!,409);
    const original = (await client.query<{ id:string;day:string;source_hash:string;source_snapshot:unknown }>(
      `SELECT e.id,e.day,e.source_hash,e.source_snapshot FROM bank_journal_entry e
       JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='clearing'
       WHERE e.kind='merchant_receipt' AND e.completion_id=$1 AND l.account_list_id=$2
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,[line.source_id,line.account_list_id])).rows[0];
    if (!original || original.day > day) throw new BankingError("BANKING_MERCHANT_RECEIPT_REQUIRED",409);
    const amount = current.source.amount_cents!;
    if (line.documented_capacity_cents !== null && line.documented_capacity_cents > amount)
      throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID",409);
    identity = { origin_entry_id:original.id,origin_hash:original.source_hash,payment:current.snapshot.payment,account_list_id:line.account_list_id };
    claims = [{source_kind:"payment_funding",source_id:line.source_id,amount_cents:line.amount_cents,capacity_cents:amount,
      source_hash:reviewHash(identity),source_snapshot:identity}];
  } else if (line.kind === "reserve_release") {
    const pieces = line.source_id.split(":");
    if (pieces.length !== 2 || !/^counterpart_[0-9]+$/.test(pieces[1]!)) throw new BankingError("BANKING_RESERVE_LOT_INVALID",409);
    const original = (await client.query<{ id:string;day:string;source_hash:string;debit_cents:string;kind:string;account_snapshot:unknown }>(
      `SELECT e.id,e.day,e.source_hash,l.debit_cents::text,l.account_snapshot,
        e.source_snapshot->'settlement'->'lines'->$3::int->>'kind' AS kind
       FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id
       WHERE e.id=$1 AND e.kind='merchant_settlement' AND l.role=$2 AND l.account_list_id=$4
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [pieces[0],pieces[1],Number(pieces[1]!.slice(12)),line.account_list_id])).rows[0];
    if (!original || original.kind !== "reserve_hold" || original.day > day || Number(original.debit_cents)<=0)
      throw new BankingError("BANKING_RESERVE_LOT_INVALID",409);
    if (line.documented_capacity_cents !== null && line.documented_capacity_cents > Number(original.debit_cents))
      throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID",409);
    identity = { origin_entry_id:original.id,origin_hash:original.source_hash,role:pieces[1],
      amount_cents:Number(original.debit_cents),account:original.account_snapshot };
    claims = [{source_kind:"reserve_lot",source_id:line.source_id,amount_cents:line.amount_cents,capacity_cents:Number(original.debit_cents),
      source_hash:reviewHash(identity),source_snapshot:identity}];
  } else {
    const fact = await movementAllocationFact(client,{role:line.kind === "fee" ? "fee" : "principal",
      account_list_id:line.account_list_id,amount_cents:line.amount_cents,
      source_kind:line.kind === "refund" ? "refund" : "document",
      source_id:line.kind === "refund" ? line.source_id : normalizeDocumentReference(line.source_id),
      documented_capacity_cents:line.documented_capacity_cents,documented_as_of:line.documented_as_of,
      recognition_owner:line.recognition_owner,evidence_id:line.evidence_id});
    identity = fact.snapshot; claims = fact.claims;
    if (line.kind === "refund") {
      const refund = fact.snapshot.identity;
      if (!["credit_card","debit_card","card"].includes(String(refund.method)))
        throw new BankingError("BANKING_MERCHANT_REFUND_METHOD_INVALID",409);
      const metadata = refund.metadata as Record<string,unknown> | null;
      const cents = Number(refund.type === "refund" ? refund.amount : metadata?.refund_amount);
      if (!Number.isSafeInteger(cents) || cents <= 0 || line.amount_cents > cents
        || (line.documented_capacity_cents !== null && line.documented_capacity_cents > cents))
        throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID",409);
    }
  }
  return { claims,snapshot:{identity,evidence:{sha256:evidence.sha256,version:evidence.version}} };
}
