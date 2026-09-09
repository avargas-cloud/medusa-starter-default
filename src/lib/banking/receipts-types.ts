import { z } from "zod";
import { reviewDate } from "./review-date";
import type { AccountingAccount } from "./accounting-types";

export type ReceiptOrigin = "receipt" | "deposit" | "payment_match";
export type ReceiptRole = "bank" | "expense" | "clearing" | "receivable";
export type ReceiptLine = { role: ReceiptRole; account_list_id: string; account_snapshot: AccountingAccount;
  account_name: string; account_type: string; debit_cents: number; credit_cents: number };
export type ReceiptJournal = { id: string; kind: ReceiptOrigin | "reversal"; day: string; amount_cents: number;
  reference: string; description: string; source_hash: string; reverses_entry_id: string | null;
  reversed_by: string | null; reason: string | null; created_at: string; stale: boolean; lines: ReceiptLine[] };
export type ReceiptSetup = { id: string; revision: number; cut_date: string; currency: "USD";
  ar_account: AccountingAccount; clearing_account: AccountingAccount; attested: true; frozen: boolean };
export type ReceiptSetupContext = { setup: ReceiptSetup | null; ar_accounts: AccountingAccount[];
  clearing_accounts: AccountingAccount[]; opening_pending: true; coverage: "partial" };
export type ReceiptSource = { id: string; kind: ReceiptOrigin; day: string; name: string; reference: string;
  amount_cents: number | null; net_cents: number | null; fee_cents: number; currency: string | null;
  payment_ids: string[]; account_id: string | null; fee_reference?: string | null };
export type ReceiptContext = { source: ReceiptSource; source_hash: string; eligible: boolean; blockers: string[];
  posting: ReceiptJournal | null; history: ReceiptJournal[]; consumed_cents: number;
  available_cents: number; opening_pending: true; coverage: "partial" };
export type ReceiptPreview = { source_hash: string; preview_hash: string; day: string; amount_cents: number;
  lines: ReceiptLine[]; blockers: string[]; opening_pending: true; coverage: "partial" };
export const receiptSetupSchema = z.object({ expected_revision: z.number().int().nonnegative(), cut_date: reviewDate,
  ar_account_list_id: z.string().min(1).max(128), clearing_account_list_id: z.string().min(1).max(128),
  local_usd_attested: z.literal(true) }).strict();
export const receiptPreviewSchema = z.object({ expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  fee_attested: z.literal(true).optional() }).strict();
export const receiptPostSchema = receiptPreviewSchema.extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) });
export const receiptReverseSchema = z.object({ posting_id: z.string().min(1).max(128), day: reviewDate,
  reason: z.string().trim().min(1).max(1000) }).strict();
export type ReceiptSetupInput = z.infer<typeof receiptSetupSchema>;
export type ReceiptPostInput = z.infer<typeof receiptPostSchema>;
export type ReceiptReverseInput = z.infer<typeof receiptReverseSchema>;
