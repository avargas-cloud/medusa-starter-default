import { z } from "zod";

import type { AccountingAccount } from "./accounting-types";
import { reviewDate } from "./review-date";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const cents = z.number().int().min(0).max(999999999999);
export const openingItemSchema = z
  .object({
    id: id.optional(),
    kind: z.enum(["uf_receipt", "deposit_in_transit", "outstanding_check"]),
    original_day: reviewDate,
    amount_cents: cents.positive(),
    external_key: z.string().trim().min(3).max(200),
    reference: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(""),
    payment_id: id.nullable().optional(),
    evidence_id: id.nullable().optional(),
  })
  .strict();
export const openingSaveSchema = z
  .object({
    id: id.optional(),
    expected_revision: z.number().int().nonnegative(),
    kind: z.enum(["bank", "clearing"]),
    bank_account_id: id.nullable().optional(),
    book_balance_cents: cents.nullable(),
    statement_balance_cents: cents.nullable(),
    statement_evidence_id: id.nullable().optional(),
    books_evidence_id: id.nullable().optional(),
    reference: z.string().trim().max(500).default(""),
    items: z.array(openingItemSchema).max(200),
  })
  .strict()
  .extend({
    book_balance_cents: z
      .number()
      .int()
      .min(-999999999999)
      .max(999999999999)
      .nullable(),
    statement_balance_cents: z
      .number()
      .int()
      .min(-999999999999)
      .max(999999999999)
      .nullable(),
  });
export const openingPreviewSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict();
export const openingAdoptSchema = openingPreviewSchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence_attested: z.literal(true),
});
export const openingRevokeSchema = openingPreviewSchema.extend({
  reason: z.string().trim().min(1).max(1000),
});
export const openingClearSchema = z
  .object({
    transaction_id: id,
    expected_source_version: z.number().int().positive(),
    expected_item_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const openingUnclearSchema = z
  .object({
    clear_id: id,
    expected_source_version: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const openingEvidenceSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime_type: z.literal("application/pdf"),
    content_base64: z.string().min(1).max(6990508),
  })
  .strict();
export type OpeningSaveInput = z.infer<typeof openingSaveSchema>;
export type OpeningItemInput = z.infer<typeof openingItemSchema>;
export type OpeningEvidence = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: string;
};
export type OpeningItem = {
  id: string;
  opening_id: string;
  kind: OpeningItemInput["kind"];
  original_day: string;
  amount_cents: number;
  external_key: string;
  reference: string;
  description: string;
  payment_id: string | null;
  evidence_id: string | null;
  source_snapshot: Record<string, unknown>;
  source_hash: string;
  available_cents: number;
  consumed_cents: number;
  clear_id: string | null;
  clear_source_version?: number | null;
  transaction_id: string | null;
  stale: boolean;
  blockers: string[];
};
export type OpeningBalance = {
  id: string;
  revision: number;
  kind: "bank" | "clearing";
  status: "draft" | "adopted" | "revoked";
  setup_id: string;
  cut_date: string;
  bank_account_id: string | null;
  account_list_id: string;
  currency: "USD";
  account_snapshot: AccountingAccount;
  book_balance_cents: number | null;
  statement_balance_cents: number | null;
  statement_evidence_id: string | null;
  books_evidence_id: string | null;
  reference: string;
  adopted_by: string | null;
  adopted_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
};
export type OpeningContext = {
  opening: OpeningBalance;
  items: OpeningItem[];
  evidence: OpeningEvidence[];
  blockers: string[];
  difference_cents: number | null;
  movements_cents: number;
  current_book_balance_cents: number | null;
  source_hash: string;
  coverage: "partial";
  zero_gl: true;
};
export type OpeningPreview = {
  opening_id: string;
  revision: number;
  preview_hash: string;
  source_hash: string;
  difference_cents: number;
  book_balance_cents: number;
  statement_balance_cents: number | null;
  item_count: number;
  blockers: string[];
  zero_gl: true;
  coverage: "partial";
};
