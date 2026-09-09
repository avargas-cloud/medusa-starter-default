import type { PoolClient } from "pg";
import { acquireBankAccountingPeriodLock, assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { bankId } from "./store";
import { BankingError } from "./security";
import { completionCapacity } from "./completion-evidence";
import type { CompletionClaim, CompletionLine, CompletionPosting } from "./movement-types";

export type CompletionKind = "movement" | "merchant_settlement" | "merchant_receipt";
export type CompletionJournalInput = { kind: CompletionKind; origin_id: string; stage: string; day: string; actor_id: string;
  reference: string; description: string; source_hash: string; source_snapshot: unknown; lines: CompletionLine[];
  claims: CompletionClaim[]; transaction_id?: string | null };

export function validateCompletionLines(lines: CompletionLine[]): number {
  if (lines.length < 2 || lines.length > 102 || new Set(lines.map(l => l.role)).size !== lines.length)
    throw new BankingError("BANKING_JOURNAL_UNBALANCED", 409);
  let debit = 0, credit = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debit_cents) || !Number.isSafeInteger(l.credit_cents)
      || l.debit_cents < 0 || l.credit_cents < 0 || (l.debit_cents > 0) === (l.credit_cents > 0)
      || l.account_snapshot.id !== l.account_list_id || l.account_snapshot.currency !== "USD"
      || (/^expense(?:_[0-9]+)?$/.test(l.role) && !["Expense", "OtherExpense"].includes(l.account_snapshot.account_type)))
      throw new BankingError("BANKING_JOURNAL_UNBALANCED", 409);
    debit += l.debit_cents; credit += l.credit_cents;
  }
  if (debit !== credit || !Number.isSafeInteger(debit) || debit <= 0 || debit > 999999999999)
    throw new BankingError("BANKING_JOURNAL_UNBALANCED", 409);
  return debit;
}
/** Called under banking-review. The SQL validator also executes from the INSERT trigger. */
export async function validateCompletionClaims(client: PoolClient, claims: CompletionClaim[]): Promise<void> {
  const keys = claims.map(c => `${c.source_kind}:${c.source_id}`);
  if (new Set(keys).size !== keys.length) throw new BankingError("BANKING_SOURCE_DUPLICATED", 409);
  for (const c of [...claims].sort((a, b) => `${a.source_kind}:${a.source_id}`.localeCompare(`${b.source_kind}:${b.source_id}`))) {
    await client.query("SELECT bank_completion_validate_claim($1,$2,$3::bigint,$4::bigint,$5,NULL)",
      [c.source_kind, c.source_id, c.amount_cents, c.capacity_cents, c.source_hash]);
  }
}
export async function completionHistory(client: PoolClient, kind: CompletionKind, id: string): Promise<CompletionPosting[]> {
  const entries = (await client.query<CompletionPosting>(`SELECT e.id,e.kind,e.completion_stage,e.day,
    e.amount_cents::float8 AS amount_cents,e.source_hash,(SELECT id FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AS reversed_by
    FROM bank_journal_entry e WHERE e.completion_id=$1 AND (e.kind=$2 OR e.kind='reversal') ORDER BY e.created_at,e.id`, [id, kind])).rows;
  for (const entry of entries) entry.lines = (await client.query<CompletionLine>(`SELECT role,account_list_id,account_snapshot,
    debit_cents::float8 AS debit_cents,credit_cents::float8 AS credit_cents FROM bank_journal_line WHERE entry_id=$1 ORDER BY role`, [entry.id])).rows;
  return entries;
}
async function writeLines(client: PoolClient, id: string, lines: CompletionLine[]): Promise<void> {
  for (const l of lines) {
    await completionCapacity(client, "bank_journal_line", 10000);
    await client.query(`INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [bankId("bjl"), id, l.role, l.account_list_id, JSON.stringify(l.account_snapshot), l.debit_cents, l.credit_cents]);
  }
}
export async function postCompletionJournal(client: PoolClient, input: CompletionJournalInput): Promise<string> {
  const amount = validateCompletionLines(input.lines);
  await acquireBankAccountingPeriodLock(client, input.day);
  await assertBankAccountingPeriodOpen(client, input.day);
  await validateCompletionClaims(client, input.claims);
  await completionCapacity(client, "bank_journal_entry", 2000);
  const id = bankId("bje");
  await client.query(`INSERT INTO bank_journal_entry(id,kind,completion_id,completion_stage,transaction_id,day,currency,
    amount_cents,source_hash,source_snapshot,reference,description,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9::jsonb,$10,$11,$12)`,
  [id, input.kind, input.origin_id, input.stage, input.transaction_id ?? null, input.day, amount, input.source_hash,
    JSON.stringify({ ...(input.source_snapshot as Record<string, unknown>), completion_lines: input.lines,
      completion_claims: input.claims }), input.reference, input.description, input.actor_id]);
  await writeLines(client, id, input.lines);
  for (const c of input.claims) {
    await completionCapacity(client, "bank_source_claim", 3000);
    await client.query(`INSERT INTO bank_source_claim(id,entry_id,source_kind,source_id,amount_cents,capacity_cents,source_hash,source_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [bankId("bsc"), id, c.source_kind, c.source_id,
      c.amount_cents, c.capacity_cents, c.source_hash, JSON.stringify(c.source_snapshot)]);
  }
  return id;
}
export async function reverseCompletionJournal(client: PoolClient, input: { kind: CompletionKind; origin_id: string; posting_id: string;
  day: string; actor_id: string; reason: string }): Promise<string> {
  const active = (await completionHistory(client, input.kind, input.origin_id))
    .find(e => e.id === input.posting_id && e.kind === input.kind && !e.reversed_by);
  if (!active || input.day < active.day) throw new BankingError("BANKING_POSTING_NOT_ACTIVE", 409);
  await acquireBankAccountingPeriodLock(client, input.day);
  await assertBankAccountingPeriodOpen(client, input.day);
  const original = (await client.query<{ transaction_id: string | null; source_snapshot: unknown; reference: string; description: string }>(
    "SELECT transaction_id,source_snapshot,reference,description FROM bank_journal_entry WHERE id=$1", [active.id])).rows[0]!;
  await completionCapacity(client, "bank_journal_entry", 2000);
  const id = bankId("bje");
  await client.query(`INSERT INTO bank_journal_entry(id,kind,completion_id,completion_stage,transaction_id,day,currency,
    amount_cents,source_hash,source_snapshot,reference,description,actor_id,reverses_entry_id,reason)
    VALUES($1,'reversal',$2,$3,$4,$5,'USD',$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
  [id, input.origin_id, active.completion_stage, original.transaction_id, input.day, active.amount_cents, active.source_hash,
    JSON.stringify(original.source_snapshot), original.reference, original.description, input.actor_id, active.id, input.reason]);
  await writeLines(client, id, active.lines.map(l => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents })));
  return id;
}
